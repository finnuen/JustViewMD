/* ==========================================================================
   JustViewMD - front end
   --------------------------------------------------------------------------
   Rendering pipeline, in order:

     1. fenced code blocks are separated out so that nothing inside them is
        ever touched by the Markdown math/footnote handling,
     2. inline code spans are parked in tokens,
     3. footnote definitions are collected (they may contain math and code),
     4. math is extracted and rendered with KaTeX - before Markdown parsing,
        which is what keeps underscores and asterisks inside formulas intact,
     5. inline code is put back so marked renders it as <code>,
     6. marked turns everything into HTML (GFM, tables, breaks),
     7. Prism highlights code blocks and Mermaid draws diagrams,
     8. tokens are expanded into the HTML KaTeX produced.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------- */
  /* Configuration                                                          */
  /* ---------------------------------------------------------------------- */

  var RENDER_DELAY_MS = 100;        // debounce for live typing
  var SNAPSHOT_DELAY_MS = 2000;     // buffer mirror sent to the host when dirty
  var MENUBAR_HOVER_MS = 200;       // rest on a menu bar button this long to open it
  var MENUBAR_CLOSE_MS = 160;       // grace to cross from the button into the menu
  var HEAVY_SOURCE_BYTES = 1500000; // above this, skip highlighting and diagrams
  var MERMAID_CACHE_LIMIT = 200;
  var MATH_CACHE_LIMIT = 4000;
  var INDENT = '  ';

  /* ---------------------------------------------------------------------- */
  /* Elements                                                               */
  /* ---------------------------------------------------------------------- */

  var editor = document.getElementById('editor');
  var editorViewport = document.getElementById('editorViewport');
  var formatBar = document.getElementById('formatBar');
  var gutterInner = document.getElementById('gutterInner');
  var markdown = document.getElementById('markdown');
  var previewViewport = document.getElementById('previewViewport');
  var workspace = document.getElementById('workspace');
  var divider = document.getElementById('divider');
  var dropOverlay = document.getElementById('dropOverlay');
  var toastElement = document.getElementById('toast');
  var aboutDialog = document.getElementById('aboutDialog');
  var aboutSummary = document.getElementById('aboutSummary');
  var aboutLicence = document.getElementById('aboutLicence');
  var aboutCloseButton = document.getElementById('aboutClose');
  var aboutReturnFocus = null;
  var contextMenu = document.getElementById('contextMenu');

  var statusFile = document.getElementById('statusFile');
  var statusCursor = document.getElementById('statusCursor');
  var statusWords = document.getElementById('statusWords');
  var statusChars = document.getElementById('statusChars');
  var statusLines = document.getElementById('statusLines');
  var statusRender = document.getElementById('statusRender');

  var menubarHint = document.getElementById('menubarHint');
  var menuButtons = {
    file: document.getElementById('menuFile'),
    edit: document.getElementById('menuEdit'),
    options: document.getElementById('menuOptions')
  };
  var tabList = document.getElementById('tabList');
  var tabAdd = document.getElementById('tabAdd');
  var tabScroller = document.getElementById('tabScroller');
  var tabStrip = tabScroller ? tabScroller.parentElement : null;
  var findBar = document.getElementById('findBar');
  var findInput = document.getElementById('findInput');
  var replaceInput = document.getElementById('replaceInput');
  var findCount = document.getElementById('findCount');
  var findPrevButton = document.getElementById('findPrev');
  var findNextButton = document.getElementById('findNext');
  var findCaseButton = document.getElementById('findCase');
  var findWordButton = document.getElementById('findWord');
  var findRegexButton = document.getElementById('findRegex');
  var replaceOneButton = document.getElementById('replaceOne');
  var replaceAllButton = document.getElementById('replaceAll');
  var findCloseButton = document.getElementById('findClose');
  var findHighlightInner = document.getElementById('findHighlightInner');
  var findScroller = document.getElementById('findScroller');
  var previewPane = document.getElementById('previewPane');
  var jumpButtons = document.getElementById('jumpButtons');
  var jumpTopButton = document.getElementById('jumpTop');
  var jumpBottomButton = document.getElementById('jumpBottom');
  var prismDarkLink = document.getElementById('prismDark');
  var prismLightLink = document.getElementById('prismLight');

  // Off-screen mirror used to work out how many visual lines each logical line
  // occupies (that is what makes line numbers line up with wrapped text).
  var measureMirror = document.createElement('div');
  measureMirror.setAttribute('aria-hidden', 'true');
  measureMirror.className = 'measure-mirror';
  document.body.appendChild(measureMirror);

  var host = (window.chrome && window.chrome.webview) ? window.chrome.webview : null;
  var outgoing = [];  // messages that had nowhere to go (see postToHost)

  /* ---------------------------------------------------------------------- */
  /* State                                                                  */
  /* ---------------------------------------------------------------------- */

  // A tab owns its text, its dirty flag and where it was left scrolled.  The
  // native host owns the paths, the names and the session; it tells the page
  // whenever either of those changes, so switching tabs never needs a round
  // trip and nothing the user typed can be lost to one.
  function blankTab(name) {
    return {
      name: name || 'Untitled.md',
      path: '',
      text: '',
      dirty: false,
      scrollTop: 0,
      previewTop: 0,
      selStart: 0,
      selEnd: 0
    };
  }

  var state = {
    tabs: [],
    active: 0,
    // The strip generation the host last described.  Every message that names a
    // tab by index repeats it, so the host can drop one that was queued before
    // a tab was added or removed and no longer means the tab it was made for.
    tabGeneration: 0,
    wrapLines: true,
    zoom: 1,
    heavy: false,
    settings: {
      viewMode: 'split',       // split | editor | preview
      dark: true,
      startBlank: false,
      wrap: true,
      defaultApp: false
    }
  };

  // Search state.  Matches are kept as offsets into the active tab's text so
  // both the highlight layer and the replace operations work off the same list.
  var find = {
    open: false,
    query: '',
    replacement: '',
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    matches: [],
    current: -1,
    invalid: false
  };

  var MAX_FIND_MATCHES = 20000;

  // Marks painted inside the rendered preview, in document order.  They are
  // rebuilt by searching the preview's own text, so this list is independent of
  // find.matches: the counter, the next/previous order and the replace
  // operations stay tied to the source offsets.
  var previewFindHits = [];
  var previewFindCurrent = -1;

  var bootLoaded = false;

  var renderTimer = null;
  var snapshotTimer = null;
  var mermaidGeneration = 0;
  var mermaidIdCounter = 0;
  var mermaidReady = false;
  var renderCounter = 0;
  var toastTimer = null;
  var mathCache = new Map();
  var mermaidCache = new Map();
  var metrics = { counts: [], prefix: [0], lineHeight: 21, paddingTop: 16, width: 0, text: null };
  var footnoteState = { defs: new Map(), order: [] };

  // Where the reader is, as a source line instead of a pixel offset, and the
  // place an action in flight is trying to keep.  See "Remembering the reading
  // position" below.
  var currentPlace = null;
  var pendingPlace = null;
  var pendingPlaceTimer = null;
  var layoutSettlingUntil = 0;
  var PLACE_HOLD_MS = 250;

  // The scroll to top / bottom pair: how long it stays after the last scroll
  // event, and how close to an end still counts as being at it.
  var JUMP_HIDE_MS = 1000;
  var JUMP_EDGE_PX = 2;
  var jumpHideTimer = null;

  /* ---------------------------------------------------------------------- */
  /* Small helpers                                                          */
  /* ---------------------------------------------------------------------- */

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function postToHost(message) {
    if (host) {
      try {
        host.postMessage(message);
      } catch (error) {
        /* the host is gone: nothing useful left to do */
      }
      return;
    }
    // Without a host (the page opened straight in a browser) the messages are
    // kept in a small ring so that the debug surface can show what was said.
    outgoing.push(message);
    if (outgoing.length > 40) {
      outgoing.shift();
    }
  }

  function showToast(text, isError) {
    toastElement.textContent = text;
    toastElement.hidden = false;
    toastElement.classList.toggle('is-error', Boolean(isError));
    // force a frame so the transition runs when the toast was hidden
    void toastElement.offsetWidth;
    toastElement.classList.add('is-visible');
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(function () {
      toastElement.classList.remove('is-visible');
      toastTimer = setTimeout(function () { toastElement.hidden = true; }, 200);
    }, isError ? 4200 : 1800);
  }

  function setRenderStatus(text, kind) {
    statusRender.textContent = text;
    statusRender.classList.toggle('is-busy', kind === 'busy');
    statusRender.classList.toggle('is-error', kind === 'error');
  }

  /* ---------------------------------------------------------------------- */
  /* Token sink: everything that must survive Markdown parsing untouched     */
  /* ---------------------------------------------------------------------- */

  function RenderSink(nonce) {
    this.nonce = nonce;
    this.tokens = [];
  }

  RenderSink.prototype.push = function (kind, payload) {
    this.tokens.push({ kind: kind, payload: payload });
    return 'JvMd' + kind + this.nonce + '_' + (this.tokens.length - 1);
  };

  RenderSink.prototype.code = function (raw) {
    return this.push('C', raw);
  };

  RenderSink.prototype.stash = function (html) {
    return this.push('H', html);
  };

  RenderSink.prototype.math = function (source, display) {
    var key = (display ? 'D\u0000' : 'I\u0000') + source;
    var html = mathCache.get(key);
    if (html === undefined) {
      try {
        html = window.katex.renderToString(source, {
          displayMode: display,
          throwOnError: true,
          strict: false,
          trust: false,
          output: 'html',
          macros: { '\\RR': '\\mathbb{R}' }
        });
      } catch (error) {
        var message = (error && error.message) ? error.message : String(error);
        html = '<span class="math-error" title="' + escapeHtml(message) + '">' +
               escapeHtml(source) + '</span>';
      }
      if (mathCache.size > MATH_CACHE_LIMIT) {
        mathCache.clear();
      }
      mathCache.set(key, html);
    }
    return this.push(display ? 'D' : 'M', html);
  };

  RenderSink.prototype.pattern = function () {
    return new RegExp('JvMd([CDHM])' + this.nonce + '_(\\d+)', 'g');
  };

  RenderSink.prototype.lookup = function (kind, index) {
    var entry = this.tokens[index];
    if (!entry || entry.kind !== kind) {
      return null;
    }
    return entry;
  };

  /* ---------------------------------------------------------------------- */
  /* Step 1 - fenced code blocks                                            */
  /* ---------------------------------------------------------------------- */

  function splitFencedBlocks(source) {
    var lines = source.split('\n');
    var segments = [];
    var current = { code: false, lines: [] };
    var fenceCharacter = '';

    for (var index = 0; index < lines.length; ++index) {
      var line = lines[index];
      var match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (!current.code) {
        if (match) {
          segments.push(current);
          current = { code: true, lines: [line] };
          fenceCharacter = match[1].charAt(0);
        } else {
          current.lines.push(line);
        }
      } else {
        current.lines.push(line);
        if (match && match[1].charAt(0) === fenceCharacter && match[2].trim() === '') {
          segments.push(current);
          current = { code: false, lines: [] };
          fenceCharacter = '';
        }
      }
    }
    segments.push(current);

    return segments.map(function (segment) {
      return { code: segment.code, text: segment.lines.join('\n') };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Step 2 - inline code spans                                             */
  /* ---------------------------------------------------------------------- */

  function protectInlineCode(text, sink) {
    return text.replace(/(`{1,3})([\s\S]*?)\1(?!`)/g, function (whole, ticks, body) {
      if (body.indexOf('\n') !== -1 && body.trim() === '') {
        return whole;
      }
      return sink.code(whole);
    });
  }

  function restoreInlineCode(text, sink) {
    return text.replace(sink.pattern(), function (whole, kind, indexText) {
      var entry = sink.lookup(kind, Number(indexText));
      return (entry && entry.kind === 'C') ? entry.payload : whole;
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Step 3 - footnote definitions                                          */
  /* ---------------------------------------------------------------------- */

  function extractFootnoteDefinitions(text, sink) {
    var lines = text.split('\n');
    var kept = [];
    for (var index = 0; index < lines.length; ++index) {
      var match = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(lines[index]);
      if (!match) {
        kept.push(lines[index]);
        continue;
      }
      var parts = [match[2]];
      var next = index + 1;
      for (; next < lines.length; ++next) {
        var line = lines[next];
        if (/^(?: {1,4}|\t)/.test(line) && line.trim() !== '') {
          parts.push(line.replace(/^(?: {1,4}|\t)/, ''));
          continue;
        }
        if (line.trim() === '' && next + 1 < lines.length &&
            /^(?: {1,4}|\t)/.test(lines[next + 1])) {
          parts.push('');
          continue;
        }
        break;
      }
      footnoteState.defs.set(match[1], parts.join('\n'));
      index = next - 1;
    }
    return kept.join('\n');
  }

  /* ---------------------------------------------------------------------- */
  /* Step 4 - math                                                          */
  /* ---------------------------------------------------------------------- */

  var MATH_PATTERN = new RegExp(
    '\\$\\$([\\s\\S]+?)\\$\\$' +                                   // $$display$$
    '|\\\\\\[([\\s\\S]+?)\\\\\\]' +                                // \[display\]
    '|\\$(?!\\s)((?:[^$\\\\\\n]|\\\\.)+?)(?<![\\s\\\\])\\$' +      // $inline$
    '|\\\\\\(([\\s\\S]+?)\\\\\\)',                                 // \(inline\)
    'g');

  function extractMath(text, sink) {
    return text.replace(MATH_PATTERN, function (whole, displayA, displayB, inlineA, inlineB) {
      if (displayA !== undefined && displayA.trim() !== '') {
        return sink.math(displayA.trim(), true);
      }
      if (displayB !== undefined && displayB.trim() !== '') {
        return sink.math(displayB.trim(), true);
      }
      if (inlineA !== undefined && inlineA.trim() !== '') {
        return sink.math(inlineA.trim(), false);
      }
      if (inlineB !== undefined && inlineB.trim() !== '') {
        return sink.math(inlineB.trim(), false);
      }
      return whole;
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Footnote support for marked                                            */
  /* ---------------------------------------------------------------------- */

  var footnoteExtension = {
    name: 'jvmdFootnote',
    level: 'inline',
    start: function (source) {
      var index = source.indexOf('[^');
      return index === -1 ? undefined : index;
    },
    tokenizer: function (source) {
      var match = /^\[\^([^\]\s]+)\]/.exec(source);
      if (!match || !footnoteState.defs.has(match[1])) {
        return undefined;
      }
      return { type: 'jvmdFootnote', raw: match[0], id: match[1] };
    },
    renderer: function (token) {
      var index = footnoteState.order.indexOf(token.id);
      if (index === -1) {
        footnoteState.order.push(token.id);
        index = footnoteState.order.length - 1;
      }
      var number = index + 1;
      return '<sup class="footnote-ref">' +
             '<a href="#fn-' + number + '" id="fnref-' + number + '" data-footnote-ref>' +
             number + '</a></sup>';
    }
  };

  function buildFootnotesSection(sink) {
    if (footnoteState.order.length === 0) {
      return '';
    }
    var items = footnoteState.order.map(function (id, index) {
      var raw = footnoteState.defs.get(id) || '';
      var body = '';
      try {
        body = window.marked.parse(restoreInlineCode(raw, sink)).trim();
      } catch (error) {
        body = '<p>' + escapeHtml(raw) + '</p>';
      }
      var number = index + 1;
      return '<li id="fn-' + number + '">' + body +
             '<a href="#fnref-' + number + '" class="footnote-backref" data-footnote-backref ' +
             'aria-label="Back to reference ' + number + '">&#8617;</a></li>';
    });
    return '<section class="footnotes" data-footnotes>' +
           '<h2 class="sr-only" id="footnote-label">Footnotes</h2>' +
           '<ol>' + items.join('') + '</ol></section>';
  }

  /* ---------------------------------------------------------------------- */
  /* Token expansion                                                        */
  /* ---------------------------------------------------------------------- */

  function expandTokens(html, sink) {
    var pattern = sink.pattern();

    // Display math that ended up alone in its own paragraph: drop the wrapper
    // so the equation is a proper block element.
    html = html.replace(new RegExp('<p>\\s*(' + pattern.source + ')\\s*</p>', 'g'),
      function (whole, token) {
        var match = /JvMd([CDHM])([0-9a-z]+)_(\d+)/.exec(token);
        if (!match) {
          return whole;
        }
        var entry = sink.lookup(match[1], Number(match[3]));
        return (entry && entry.kind === 'D') ? entry.payload : whole;
      });

    pattern.lastIndex = 0;
    return html.replace(pattern, function (whole, kind, indexText) {
      var entry = sink.lookup(kind, Number(indexText));
      return entry ? entry.payload : whole;
    });
  }

  /* ---------------------------------------------------------------------- */
  /* The Markdown pipeline                                                  */
  /* ---------------------------------------------------------------------- */

  function renderMarkdown(source) {
    var sink = new RenderSink((++renderCounter).toString(36));
    footnoteState = { defs: new Map(), order: [] };

    var segments = splitFencedBlocks(source);
    var assembled = segments.map(function (segment) {
      if (segment.code) {
        return segment.text;
      }
      var text = segment.text;
      text = protectInlineCode(text, sink);
      text = extractFootnoteDefinitions(text, sink);
      text = extractMath(text, sink);
      text = restoreInlineCode(text, sink);
      return text;
    }).join('\n');

    var html = '';
    try {
      html = window.marked.parse(assembled);
    } catch (error) {
      return '<p class="math-error">Markdown parsing failed: ' + escapeHtml(error && error.message) + '</p>';
    }

    return expandTokens(html + buildFootnotesSection(sink), sink);
  }

  /* ---------------------------------------------------------------------- */
  /* Callouts                                                               */
  /* ---------------------------------------------------------------------- */

  // "> [!NOTE]" and its four companions open a callout.  The marker is the
  // first thing in the blockquote: what follows it on that line is the title,
  // and the rest of the quote is the body.  The quote becomes a div so a
  // callout is not announced as a quotation, and the two themes colour it from
  // the same rules.
  var ALERT_KINDS = {
    note: 'Note',
    tip: 'Tip',
    important: 'Important',
    warning: 'Warning',
    caution: 'Caution'
  };

  var ALERT_ICONS = {
    note: '<circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
          '<path d="M8 7.1v4.4M8 4.5v.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    tip: '<path d="M8 1.4a4.2 4.2 0 0 0-2.5 7.6c.4.3.6.7.6 1.1v.3h3.8v-.3c0-.4.2-.8.6-1.1A4.2 4.2 0 0 0 8 1.4Z" ' +
         'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
         '<path d="M6.4 12h3.2M6.9 14.1h2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    important: '<circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
               '<path d="M8 4.4v4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
               '<circle cx="8" cy="11.7" r=".9" fill="currentColor"/>',
    warning: '<path d="M8 1.9 14.8 14H1.2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
             '<path d="M8 6v3.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
             '<circle cx="8" cy="11.7" r=".85" fill="currentColor"/>',
    caution: '<path d="M5.1 1.2h5.8l3.9 3.9v5.8l-3.9 3.9H5.1L1.2 10.9V5.1Z" fill="none" ' +
             'stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
             '<path d="M8 4.4v4.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
             '<circle cx="8" cy="11.5" r=".85" fill="currentColor"/>'
  };

  function alertIcon(kind) {
    return '<svg class="markdown-alert-icon" viewBox="0 0 16 16" width="16" height="16" ' +
           'aria-hidden="true">' + ALERT_ICONS[kind] + '</svg>';
  }

  function convertAlerts(container) {
    var quotes = container.querySelectorAll('blockquote');
    for (var index = 0; index < quotes.length; ++index) {
      var quote = quotes[index];
      var first = quote.firstElementChild;
      if (!first || first.tagName !== 'P' || !first.firstChild) {
        continue;
      }
      // The marker is ordinary text at the start of the first run, which marked
      // leaves whole: it is not a link, code or emphasis.
      var run = first.firstChild;
      if (run.nodeType !== 3) {
        continue;
      }
      var match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]([ \t]*)([^\n]*)/i.exec(run.nodeValue);
      if (!match) {
        continue;
      }
      var kind = match[1].toLowerCase();
      var custom = match[3].trim();
      // The rest of the marker line is the title and the body starts on the
      // next line, whether marked kept that newline or turned it into a <br>.
      var rest = run.nodeValue.slice(match[0].length);
      var lineEnd = rest.indexOf('\n');
      rest = lineEnd === -1 ? '' : rest.slice(lineEnd + 1);
      if (rest) {
        run.nodeValue = rest;
      } else {
        run.parentNode.removeChild(run);
      }
      while (first.firstChild && first.firstChild.nodeName === 'BR') {
        first.removeChild(first.firstChild);
      }
      if (!first.firstChild) {
        first.parentNode.removeChild(first);
      }

      var callout = document.createElement('div');
      callout.className = 'markdown-alert markdown-alert-' + kind;
      var title = document.createElement('p');
      title.className = 'markdown-alert-title';
      title.innerHTML = alertIcon(kind) + escapeHtml(custom || ALERT_KINDS[kind]);
      callout.appendChild(title);
      while (quote.firstChild) {
        callout.appendChild(quote.firstChild);
      }
      quote.parentNode.replaceChild(callout, quote);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Prism and Mermaid                                                      */
  /* ---------------------------------------------------------------------- */

  function highlightCodeBlocks(container) {
    if (!window.Prism || state.heavy) {
      return;
    }
    var blocks = container.querySelectorAll('pre > code');
    for (var index = 0; index < blocks.length; ++index) {
      var block = blocks[index];
      if (block.classList.contains('language-mermaid')) {
        continue;
      }
      try {
        window.Prism.highlightElement(block);
      } catch (error) {
        /* unknown language: leave the block as plain text */
      }
    }
  }

  function replaceMermaidBlock(pre, svg) {
    var wrapper = document.createElement('div');
    wrapper.className = 'mermaid-block';
    wrapper.innerHTML = svg;
    pre.parentNode.replaceChild(wrapper, pre);
  }

  function showMermaidError(pre, message, diagram) {
    var wrapper = document.createElement('div');
    wrapper.className = 'mermaid-error';
    wrapper.innerHTML = '<strong>Mermaid could not render this diagram.</strong><br>' +
                        escapeHtml(message) +
                        '<pre>' + escapeHtml(diagram) + '</pre>';
    pre.parentNode.replaceChild(wrapper, pre);
  }

  function renderMermaidBlocks(container, generation) {
    if (!mermaidReady || state.heavy) {
      return;
    }
    var blocks = container.querySelectorAll('pre > code.language-mermaid');
    for (var index = 0; index < blocks.length; ++index) {
      (function (code) {
        var pre = code.parentElement;
        if (!pre) {
          return;
        }
        var diagram = code.textContent || '';
        var key = diagram.trim();
        if (mermaidCache.has(key)) {
          replaceMermaidBlock(pre, mermaidCache.get(key));
          return;
        }
        var identifier = 'jvmd-mermaid-' + (++mermaidIdCounter);
        window.mermaid.render(identifier, diagram).then(function (result) {
          if (generation !== mermaidGeneration) {
            return;  // a newer render replaced this one
          }
          if (mermaidCache.size > MERMAID_CACHE_LIMIT) {
            mermaidCache.clear();
          }
          mermaidCache.set(key, result.svg);
          if (pre.parentNode) {
            replaceMermaidBlock(pre, result.svg);
          }
        }).catch(function (error) {
          if (generation !== mermaidGeneration) {
            return;
          }
          var message = (error && error.message) ? error.message : String(error);
          if (pre.parentNode) {
            showMermaidError(pre, message, diagram);
          }
        });
      }(blocks[index]));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Copying a code block                                                   */
  /* ---------------------------------------------------------------------- */

  var COPY_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
    '<rect x="5.3" y="5.3" width="8" height="8" rx="1.4" fill="none" stroke="currentColor" ' +
    'stroke-width="1.4"/>' +
    '<path d="M10.7 5.3V3.7a1.4 1.4 0 0 0-1.4-1.4H3.7a1.4 1.4 0 0 0-1.4 1.4v5.6a1.4 1.4 0 0 0 1.4 1.4h1.6" ' +
    'fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

  var COPIED_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
    '<path d="M3.3 8.5 6.2 11.4 12.7 4.8" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function copyPlainText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      document.body.appendChild(area);
      area.select();
      var copied = false;
      try {
        copied = document.execCommand('copy');
      } catch (error) {
        copied = false;
      }
      document.body.removeChild(area);
      if (copied) {
        resolve();
      } else {
        reject(new Error('copy failed'));
      }
    });
  }

  // A fenced block gets a button in its corner.  The block is wrapped so the
  // button can sit still while the code scrolls under it, and the button is a
  // sibling of the code so it is never part of the text that is copied.
  function addCodeCopyButtons(container) {
    var blocks = container.querySelectorAll('pre > code');
    for (var index = 0; index < blocks.length; ++index) {
      var code = blocks[index];
      if (code.classList.contains('language-mermaid')) {
        continue;   // drawn as a diagram, so there is no text to copy
      }
      var pre = code.parentElement;
      if (!pre || (pre.parentElement && pre.parentElement.classList.contains('code-block'))) {
        continue;
      }
      var wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-copy';
      button.title = 'Copy code';
      button.setAttribute('aria-label', 'Copy code');
      button.innerHTML = COPY_ICON;
      button.addEventListener('click', function () {
        var target = this.parentElement.querySelector('pre > code');
        var text = target ? target.textContent : '';
        var control = this;
        copyPlainText(text).then(function () {
          control.innerHTML = COPIED_ICON;
          control.classList.add('is-copied');
          control.title = 'Copied';
          clearTimeout(control.copyTimer);
          control.copyTimer = setTimeout(function () {
            control.innerHTML = COPY_ICON;
            control.classList.remove('is-copied');
            control.title = 'Copy code';
          }, 1600);
        }).catch(function () {
          showToast('Copy failed', true);
        });
      });
      wrapper.appendChild(button);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Remote images                                                          */
  /* ---------------------------------------------------------------------- */

  // An image on the web is never loaded by this page.  The host downloads it
  // once into %LOCALAPPDATA%\JustViewMD\cache and answers with an address to
  // the local copy; what is remembered below is what the preview is really
  // built from, so a document looks the same offline once its images have been
  // seen, and a redraw never asks for one twice.
  var REMOTE_IMAGE_RETRY_MS = 15000;
  var REMOTE_IMAGE_RETRIES = 5;
  var remoteImages = new Map();   // remote url -> local url, or null when it failed
  var remotePending = new Set();  // urls a request is out for
  var remoteAttempts = new Map(); // urls whose cached copy failed to load, and how often

  function isDownloadableImage(source) {
    if (!/^https?:\/\//i.test(source)) {
      return false;
    }
    // The viewer's own two hosts carry the front end and the cache; everything
    // else on the web is an image the host has to fetch.
    return !/^https?:\/\/(?:app|cache)\.local(?:[:\/]|$)/i.test(source);
  }

  // The host answers with imageReady or imageFailed.  While an answer is on its
  // way the element keeps the address from the document, which the content
  // security policy refuses - a picture that cannot be fetched therefore looks
  // exactly as it did before the cache existed.  The retry is for an answer
  // that never arrives at all (a reloaded page, a host that is busy).
  function requestRemoteImage(remote, attempt) {
    remotePending.add(remote);
    postToHost({ type: 'fetchImage', url: remote });
    if (attempt >= REMOTE_IMAGE_RETRIES) {
      return;
    }
    setTimeout(function () {
      if (!remotePending.has(remote) || remoteImages.has(remote)) {
        return;  // answered in the meantime
      }
      requestRemoteImage(remote, attempt + 1);
    }, REMOTE_IMAGE_RETRY_MS);
  }

  // The same sentence is used when the answer arrives and on every later render,
  // so the explanation survives the next keystroke.
  function remoteImageNote(remote) {
    return 'JustViewMD could not download this image: ' + remote;
  }

  // Points one element at its cached copy, and listens for that copy failing to
  // load.  The cache folder is open to the user, so the file behind a picture
  // can be gone by the time the browser asks for it; one failed load is worth
  // another try, because the host then finds nothing cached and fetches it
  // again.  A copy that loads is a good copy, which re-arms the retry.
  function showCachedImage(image, remote, local) {
    if (image.getAttribute('src') !== local) {
      image.setAttribute('src', local);
    }
    if (image.getAttribute('data-remote-watch') === remote) {
      return;
    }
    image.setAttribute('data-remote-watch', remote);
    image.addEventListener('load', function () {
      remoteAttempts.delete(remote);
    });
    image.addEventListener('error', function () {
      var attempts = remoteAttempts.get(remote) || 0;
      if (attempts >= 3) {
        image.title = remoteImageNote(remote);  // it will not load however often it is asked
        return;
      }
      remoteAttempts.set(remote, attempts + 1);
      remoteImages.delete(remote);
      remotePending.delete(remote);
      // Dropping the address first makes the next one a change: a copy that is
      // put back into place is then loaded, instead of being ignored as the
      // same failing address.
      image.removeAttribute('src');
      applyRemoteImages(markdown);
    });
  }

  // A <picture> offers one file per colour scheme.  The file is chosen here
  // from the theme this window is using, so the picture agrees with the pane
  // around it; left to the browser it would follow the operating system's
  // setting, which is not what the reader picked.
  function firstSrcsetAddress(value) {
    var text = String(value || '').replace(/^\s+/, '');
    if (!text) {
      return '';
    }
    var comma = text.indexOf(',');
    var candidate = comma === -1 ? text : text.slice(0, comma);
    return candidate.trim().split(/\s+/)[0] || '';
  }

  function applyPictureSources(container) {
    var pictures = container.querySelectorAll('picture');
    for (var index = 0; index < pictures.length; ++index) {
      var picture = pictures[index];
      var image = picture.querySelector('img');
      var sources = picture.querySelectorAll('source');
      if (!image) {
        continue;
      }
      for (var option = 0; option < sources.length; ++option) {
        var media = sources[option].getAttribute('media') || '';
        var scheme = /prefers-color-scheme\s*:\s*(dark|light)/i.exec(media);
        var matches;
        if (scheme) {
          matches = (scheme[1].toLowerCase() === 'dark') === Boolean(state.settings.dark);
        } else if (media) {
          matches = window.matchMedia(media).matches;
        } else {
          matches = true;
        }
        if (!matches) {
          continue;
        }
        var address = firstSrcsetAddress(sources[option].getAttribute('srcset'));
        if (address) {
          image.setAttribute('src', address);
        }
        break;
      }
      // The sources go: left in place, the browser would pick from them by the
      // system setting and override the file chosen above.
      for (var removal = sources.length - 1; removal >= 0; --removal) {
        sources[removal].parentNode.removeChild(sources[removal]);
      }
    }
  }

  function applyRemoteImages(container) {
    var images = container.querySelectorAll('img');
    for (var index = 0; index < images.length; ++index) {
      var image = images[index];
      var remote = image.getAttribute('data-remote-src');
      if (!remote) {
        var source = image.getAttribute('src') || '';
        if (!isDownloadableImage(source)) {
          continue;
        }
        remote = source;
        image.setAttribute('data-remote-src', remote);
      }
      var local = remoteImages.get(remote);
      if (local) {
        showCachedImage(image, remote, local);
        continue;
      }
      if (remoteImages.has(remote)) {
        // Known to have failed: the element keeps the address from the
        // document, and the tooltip says why nothing appeared.
        image.title = remoteImageNote(remote);
        continue;
      }
      if (remotePending.has(remote)) {
        continue;  // already on its way
      }
      requestRemoteImage(remote, 1);
    }
  }

  function remoteImageAnswered(data) {
    var remote = String(data.url || '');
    if (!remote) {
      return;
    }
    var local = (data.type === 'imageReady' && data.src) ? String(data.src) : null;
    remoteImages.set(remote, local);
    remotePending.delete(remote);
    var images = markdown.querySelectorAll('img[data-remote-src]');
    for (var index = 0; index < images.length; ++index) {
      var image = images[index];
      if (image.getAttribute('data-remote-src') !== remote) {
        continue;
      }
      if (local) {
        showCachedImage(image, remote, local);
      } else {
        image.title = remoteImageNote(remote);
      }
    }
  }

  // The host measures the cache when the page is loaded and again whenever the
  // Options menu is opened, so the number there is never stale by much.
  var imageCache = null;  // { files, bytes } as last reported by the host

  /* --- a picture that sits next to the document --------------------------- */

  // The page cannot read the disk.  A picture a document points at next to
  // itself is handed to the host as an absolute path through the one address
  // that already means "the host prepared this picture"
  // (https://cache.local/local?path=...), and the host answers with the file
  // itself: nothing is copied into the cache and no request leaves the machine.
  var LOCAL_IMAGE_ORIGIN = 'https://local.local/local?path=';

  function documentFolder() {
    var tab = activeTab();
    var path = (tab && tab.path) ? tab.path : '';
    var slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
    return slash > 0 ? path.slice(0, slash) : '';
  }

  function decodeAddress(text) {
    try {
      return decodeURIComponent(text);
    } catch (error) {
      return text;  // a stray % in the name, not an escape
    }
  }

  // An address that names a file on the disk rather than a page on the web.
  // data: and blob: pictures are already complete, and http(s) ones belong to
  // the download cache above.
  function isLocalImageSource(source) {
    if (!source || source.charAt(0) === '#') {
      return false;
    }
    if (/^(?:data|blob|https?):/i.test(source)) {
      return false;
    }
    // The renderer percent-encodes a Markdown destination, so a Windows path
    // written as E:\folder\file.png arrives here as E:%5Cfolder%5Cfile.png.
    // The tests below have to read the address the way the file system does.
    var decoded = decodeAddress(source);
    if (/^file:/i.test(decoded)) {
      return true;
    }
    if (/^[A-Za-z]:[\\/]/.test(decoded) || /^\\\\/.test(decoded)) {
      return true;
    }
    // Any other scheme names something this program cannot read.
    return !/^[a-z][a-z0-9+.-]*:/i.test(decoded);
  }

  // The address in the Markdown, resolved against the document's own folder.
  // '' means there is nothing to read: the document is unsaved, or the name is
  // relative to a root that means nothing on Windows.
  function resolveLocalPath(source) {
    var address = String(source || '').replace(/[?#].*$/, '');
    if (!address) {
      return '';
    }
    if (/^file:/i.test(address)) {
      var drive = /^file:\/\/\/([A-Za-z]:[\\/].*)$/i.exec(address);
      if (drive) {
        return decodeAddress(drive[1]).replace(/\//g, '\\');
      }
      var share = /^file:\/\/([^\/].*)$/i.exec(address);
      if (share) {
        return ('\\\\' + decodeAddress(share[1])).replace(/\//g, '\\');
      }
      return '';
    }
    var decoded = decodeAddress(address);
    if (/^[A-Za-z]:[\\/]/.test(decoded)) {
      return decoded.replace(/\//g, '\\');
    }
    if (/^\\\\/.test(decoded)) {
      return decoded;
    }
    if (/^[A-Za-z]:/.test(decoded) || decoded.charAt(0) === '/') {
      return '';
    }
    var folder = documentFolder();
    if (!folder) {
      return '';
    }
    // Walk the segments so ".." can climb but never leave the root, and put the
    // leading double backslash of a UNC share back afterwards.
    var shareRoot = /^\\\\/.test(folder);
    var parts = (folder + '\\' + decoded).split(/[\\/]+/);
    var resolved = [];
    for (var index = 0; index < parts.length; ++index) {
      var part = parts[index];
      if (!part || part === '.') {
        continue;
      }
      if (part === '..') {
        if (resolved.length > (shareRoot ? 2 : 1)) {
          resolved.pop();
        }
        continue;
      }
      resolved.push(part);
    }
    var path = resolved.join('\\');
    return shareRoot ? '\\\\' + path : path;
  }

  // An <img> can offer several files, one per screen density.  Each address is
  // a file like the src, so each is resolved against the document and pointed
  // at the host, keeping whatever follows the address.
  function applyLocalSrcset(image) {
    var original = image.getAttribute('data-local-srcset');
    if (!original) {
      original = image.getAttribute('srcset');
      if (!original) {
        return;
      }
      image.setAttribute('data-local-srcset', original);
    }
    var candidates = original.split(',');
    var rewritten = [];
    for (var index = 0; index < candidates.length; ++index) {
      var candidate = candidates[index].trim();
      if (!candidate) {
        continue;
      }
      var split = candidate.search(/\s/);
      var address = split === -1 ? candidate : candidate.slice(0, split);
      var descriptor = split === -1 ? '' : candidate.slice(split);
      if (isLocalImageSource(address)) {
        var path = resolveLocalPath(address);
        if (path) {
          address = LOCAL_IMAGE_ORIGIN + encodeURIComponent(path);
        }
      }
      rewritten.push(address + descriptor);
    }
    image.setAttribute('srcset', rewritten.join(', '));
  }

  function applyLocalImages(container) {
    var images = container.querySelectorAll('img');
    for (var index = 0; index < images.length; ++index) {
      var image = images[index];
      if (image.getAttribute('data-remote-src')) {
        continue;  // a picture from the web, already handled
      }
      applyLocalSrcset(image);
      var source = image.getAttribute('src') || '';
      if (!isLocalImageSource(source)) {
        continue;
      }
      var path = resolveLocalPath(source);
      var address = path ? LOCAL_IMAGE_ORIGIN + encodeURIComponent(path) : '';
      if (image.getAttribute('data-local-path') === path &&
          image.getAttribute('src') === address) {
        continue;  // already pointed at this file
      }
      image.setAttribute('data-local-src', source);
      image.setAttribute('data-local-path', path);
      if (!path) {
        image.removeAttribute('src');
        image.title = documentFolder()
          ? 'JustViewMD could not resolve this picture: ' + source
          : 'Save the document before a local picture can be shown: ' + source;
        continue;
      }
      // The file behind the picture can move or change while the page is open;
      // when it stops loading, the tooltip says which file was tried.
      image.addEventListener('error', function () {
        this.title = 'JustViewMD could not show this picture: ' + path;
      });
      image.setAttribute('src', address);
    }
  }

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    var mib = 1024 * 1024;
    if (value < 1024) {
      return value + ' B';
    }
    if (value < mib) {
      return Math.round(value / 1024) + ' KB';
    }
    if (value < 10 * mib) {
      return (value / mib).toFixed(1) + ' MB';  // 5.6 MB, not a rounded 6 MB
    }
    if (value < 1024 * mib) {
      return Math.round(value / mib) + ' MB';
    }
    return (value / (1024 * mib)).toFixed(1) + ' GB';
  }

  function imageCacheLabel() {
    if (!imageCache) {
      return 'Cached images: \u2026';
    }
    var bytes = Number(imageCache.bytes) || 0;
    return 'Cached images: ' + (bytes > 0 ? formatBytes(bytes) : 'none');
  }

  // The host checks the release feed when the window opens and whenever
  // the Options menu asks, and it reports where the check stands.  This is only
  // ever a menu row and a toast: the start-up check never interrupts.
  var updateState = null;  // { state, current, latest, url, message, asked }

  function updateHint() {
    var current = (updateState && updateState.current) || '';
    if (updateState && updateState.state === 'available' && updateState.latest) {
      return current + ' \u2192 ' + updateState.latest;
    }
    return current;
  }

  // What a check the user asked for says.  A check that runs by itself at
  // start-up answers null: it is background work and must not bother anyone.
  function updateToastText(data) {
    if (data.state === 'checking') {
      return 'Checking for updates\u2026';
    }
    if (data.state === 'available') {
      return data.current + ' \u2192 ' + data.latest + ' is available';
    }
    if (data.state === 'uptodate') {
      return 'JustViewMD ' + data.current + ' is the latest version';
    }
    if (data.state === 'failed') {
      return 'Could not check for updates: ' + (data.message || 'the request failed');
    }
    return null;
  }

  /* ---------------------------------------------------------------------- */
  /* Debounced rendering                                                    */
  /* ---------------------------------------------------------------------- */

  function renderNow() {
    var source = editor.value;
    // In the preview-only view the editor is off screen, and a hidden textarea
    // cannot hold a scroll position: syncing the preview from it would send the
    // reader back to the top on every re-render (a theme change, a reload).
    // The preview's own place is kept instead.
    var keepPreviewTop = state.settings.viewMode === 'preview' ? previewViewport.scrollTop : null;
    state.heavy = source.length > HEAVY_SOURCE_BYTES;
    setRenderStatus(state.heavy ? 'Large document' : 'Rendering\u2026', 'busy');

    var started = performance.now();
    mermaidGeneration += 1;
    var generation = mermaidGeneration;

    markdown.innerHTML = renderMarkdown(source);
    // The old marks went with the markup they were wrapped around.
    previewSelectionHits.length = 0;
    convertAlerts(markdown);
    highlightCodeBlocks(markdown);
    renderMermaidBlocks(markdown, generation);
    applyPictureSources(markdown);
    applyRemoteImages(markdown);
    applyLocalImages(markdown);
    addCodeCopyButtons(markdown);
    // A theme change or a reload redraws the page under a selection that is
    // still in the editor, so the mark is painted again on the fresh layout.
    paintPreviewSelection();

    var elapsed = performance.now() - started;
    if (state.heavy) {
      setRenderStatus('Large document \u2013 highlighting off', 'busy');
    } else {
      setRenderStatus(elapsed > 500 ? 'Rendered in ' + Math.round(elapsed) + ' ms' : 'Ready', null);
    }

    updateCounts();
    // Reading layout here rather than from a requestAnimationFrame callback keeps
    // the gutter correct even when the page is not being painted (occluded or
    // minimised windows do not run animation frames).
    renderGutter();
    if (keepPreviewTop === null) {
      syncScrollFrom(editor);
    } else {
      previewViewport.scrollTop = keepPreviewTop;
      programmatic.preview = previewViewport.scrollTop;
    }
    if (find.open) {
      // The text changed under the search: re-match so the highlights and the
      // counter stay true, and repaint them on the fresh layout.
      refreshFindMatches(true);
    }
  }

  function scheduleRender() {
    if (renderTimer) {
      clearTimeout(renderTimer);
    }
    renderTimer = setTimeout(function () {
      renderTimer = null;
      renderNow();
    }, RENDER_DELAY_MS);
  }

  /* ---------------------------------------------------------------------- */
  /* Line metrics for the number gutter                                     */
  /* ---------------------------------------------------------------------- */

  function computeMetrics() {
    var style = getComputedStyle(editor);
    var lineHeight = parseFloat(style.lineHeight);
    if (!isFinite(lineHeight) || lineHeight <= 0) {
      lineHeight = 21;
    }
    var paddingTop = parseFloat(style.paddingTop) || 0;
    var contentWidth = Math.max(80, editor.clientWidth -
      (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0));
    var text = editor.value;

    if (metrics.text === text && Math.abs(metrics.width - contentWidth) < 0.5 &&
        metrics.lineHeight === lineHeight) {
      return;
    }

    var lines = text.split('\n');
    var counts = new Array(lines.length);
    var index;

    if (state.wrapLines && lines.length <= 40000) {
      measureMirror.style.width = contentWidth + 'px';
      var fragment = document.createDocumentFragment();
      for (index = 0; index < lines.length; ++index) {
        var cell = document.createElement('div');
        cell.textContent = lines[index].length ? lines[index] : '\u200b';
        fragment.appendChild(cell);
      }
      measureMirror.textContent = '';
      measureMirror.appendChild(fragment);
      var cells = measureMirror.children;
      for (index = 0; index < lines.length; ++index) {
        var height = cells[index].offsetHeight;
        counts[index] = Math.max(1, Math.round(height / lineHeight));
      }
    } else {
      for (index = 0; index < lines.length; ++index) {
        counts[index] = 1;
      }
    }

    var prefix = new Array(lines.length + 1);
    prefix[0] = 0;
    for (index = 0; index < lines.length; ++index) {
      prefix[index + 1] = prefix[index] + counts[index];
    }

    metrics = {
      counts: counts,
      prefix: prefix,
      lineHeight: lineHeight,
      paddingTop: paddingTop,
      width: contentWidth,
      text: text
    };
  }

  function cursorLineIndex() {
    var text = editor.value;
    var position = editor.selectionStart || 0;
    var line = 0;
    for (var index = 0; index < position && index < text.length; ++index) {
      if (text.charCodeAt(index) === 10) {
        ++line;
      }
    }
    return line;
  }

  function renderGutter() {
    computeMetrics();
    var counts = metrics.counts;
    if (!counts.length) {
      gutterInner.innerHTML = '';
      return;
    }

    var lineHeight = metrics.lineHeight;
    var scrollTop = editor.scrollTop;
    var visibleLines = Math.ceil(editor.clientHeight / lineHeight) + 2;
    var firstVisual = Math.max(0, Math.floor(scrollTop / lineHeight));

    // Binary search: the logical line that owns the first visible visual line.
    var low = 0;
    var high = counts.length - 1;
    var start = 0;
    while (low <= high) {
      var middle = (low + high) >> 1;
      if (metrics.prefix[middle] <= firstVisual) {
        start = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    var lastVisual = firstVisual + visibleLines;
    var end = start;
    while (end < counts.length && metrics.prefix[end] < lastVisual) {
      ++end;
    }
    end = Math.min(counts.length, end + 1);

    var current = cursorLineIndex();
    var html = '';
    for (var index = start; index < end; ++index) {
      html += '<div class="ln' + (index === current ? ' ln-current' : '') + '" style="height:' +
              (counts[index] * lineHeight) + 'px">' + (index + 1) + '</div>';
    }
    gutterInner.innerHTML = html;
    gutterInner.style.transform =
      'translateY(' + (metrics.paddingTop + metrics.prefix[start] * lineHeight - scrollTop).toFixed(1) + 'px)';
  }

  /* ---------------------------------------------------------------------- */
  /* Status bar                                                             */
  /* ---------------------------------------------------------------------- */

  function updateFileStatus() {
    var tab = activeTab();
    var name = tab ? tab.name : 'Untitled.md';
    var dirty = tab ? tab.dirty : false;
    statusFile.textContent = name;
    statusFile.classList.toggle('is-dirty', dirty);
    menubarHint.textContent = tab && tab.path ? tab.path : '';
    menubarHint.title = menubarHint.textContent;
    document.title = name + (dirty ? '*' : '') + ' \u2014 JustViewMD';
  }

  function updateCursorStatus() {
    var text = editor.value;
    var position = editor.selectionStart || 0;
    var line = 1;
    var column = 1;
    for (var index = 0; index < position && index < text.length; ++index) {
      if (text.charCodeAt(index) === 10) {
        ++line;
        column = 1;
      } else {
        ++column;
      }
    }
    statusCursor.textContent = 'Ln ' + line + ', Col ' + column;
  }

  function updateCounts() {
    var text = editor.value;
    var words = text.length ? (text.match(/[^\s]+/g) || []).length : 0;
    statusWords.textContent = words.toLocaleString() + (words === 1 ? ' word' : ' words');
    statusChars.textContent = text.length.toLocaleString() + (text.length === 1 ? ' char' : ' chars');
    var lines = text.length ? text.split('\n').length : 1;
    statusLines.textContent = lines.toLocaleString() + (lines === 1 ? ' line' : ' lines');
    updateCursorStatus();
    updateFileStatus();
  }

  /* ---------------------------------------------------------------------- */
  /* Synchronised scrolling                                                 */
  /* ---------------------------------------------------------------------- */

  // Scrolling keeps the same *source line* near the top of both panes.  A
  // proportional mapping would drift as soon as the two sides have different
  // heights - one screenshot, table, or diagram is enough - so the mapping goes
  // through a table that pairs every top level preview block with the source
  // line it came from.  Proportional scrolling remains the fallback for when
  // that table cannot be trusted.
  var programmatic = { editor: -1, preview: -1 };
  var anchors = [];          // { line, top } per top level block, in source order
  var anchorsHeight = -1;    // preview scrollHeight the table was measured at
  var anchorsStamp = -1;     // renderCounter the table was built for

  function maxScroll(element) {
    return Math.max(0, element.scrollHeight - element.clientHeight);
  }

  /* --- reading the source ------------------------------------------------- */

  function isBlankLine(line) {
    return line === undefined || /^\s*$/.test(line);
  }

  function isFenceLine(line) {
    var match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    return match ? match[1].charAt(0) : null;
  }

  function isAtxHeading(line) {
    return /^\s{0,3}#{1,6}(\s|$)/.test(line);
  }

  function isThematicBreak(line) {
    return /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
  }

  function isListMarker(line) {
    return /^\s{0,3}(?:[-+*]|\d{1,9}[.)])(\s|$)/.test(line);
  }

  function isQuoteLine(line) {
    return /^\s{0,3}>/.test(line);
  }

  function isIndentedCode(line) {
    return /^(?: {4,}|\t)/.test(line);
  }

  // A cheap scan that reports the first source line of every top level block.
  // It follows the same rules marked does for the constructs that matter here
  // and gives up (reporting nothing) rather than guessing when the structure is
  // ambiguous.
  function scanBlockLines(lines) {
    var starts = [];
    var count = lines.length;
    var index = 0;

    while (index < count) {
      if (isBlankLine(lines[index])) {
        index += 1;
        continue;
      }

      var start = index;
      var fence = isFenceLine(lines[index]);
      starts.push(start);

      if (fence) {
        var marker = fence.charAt(0);
        var run = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[index])[1].length;
        index += 1;
        while (index < count) {
          var closing = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[index]);
          if (closing && closing[1].charAt(0) === marker && closing[1].length >= run) {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }

      if (isAtxHeading(lines[index]) || isThematicBreak(lines[index])) {
        index += 1;
        continue;
      }

      // Lists, quotes, indented code, and paragraphs all end at the first blank
      // line; a line that opens a new block ends them too (lazy continuation).
      var kind = isQuoteLine(lines[index]) ? 'quote'
               : isIndentedCode(lines[index]) ? 'code'
               : isListMarker(lines[index]) ? 'list'
               : 'paragraph';

      index += 1;
      while (index < count) {
        var line = lines[index];
        if (isBlankLine(line)) {
          break;
        }
        if (kind === 'paragraph' && (isFenceLine(line) || isAtxHeading(line) ||
                                     isThematicBreak(line) || isListMarker(line) ||
                                     isQuoteLine(line))) {
          break;
        }
        if (kind === 'list' && !isListMarker(line) && isThematicBreak(line)) {
          break;
        }
        index += 1;
      }
    }

    return starts;
  }

  /* --- the anchor table --------------------------------------------------- */

  // Rebuilt only when the rendered document or its measured height changed;
  // both are cheap to check and the rebuild is a single layout pass.
  function ensureAnchors() {
    var height = previewViewport.scrollHeight;
    if (anchorsHeight === height && anchorsStamp === renderCounter) {
      return;
    }
    anchorsHeight = height;
    anchorsStamp = renderCounter;
    anchors = [];

    var children = markdown.children;
    if (!children.length) {
      return;
    }

    var starts = scanBlockLines(editor.value.split('\n'));
    if (starts.length !== children.length) {
      // The scan and the render disagree about the block structure, so the
      // pairing would be off by an unknown amount: stay proportional.
      return;
    }

    // Positions are measured against the top of the scroll viewport, so an
    // anchor's "top" is exactly the scrollTop that brings it to the top edge.
    // (Measuring against the article instead would cancel scrollTop out of the
    // sum whenever the table is rebuilt while the pane is already scrolled.)
    var origin = previewViewport.getBoundingClientRect().top - previewViewport.scrollTop;
    for (var index = 0; index < children.length; ++index) {
      anchors.push({
        line: starts[index],
        top: children[index].getBoundingClientRect().top - origin
      });
    }
  }

  /* --- converting between the panes --------------------------------------- */

  // The visual (wrapped) line the editor is scrolled to, as a float.
  function editorVisualTop() {
    var lineHeight = metrics.lineHeight > 0 ? metrics.lineHeight : 1;
    return editor.scrollTop / lineHeight;
  }

  // The logical line that owns a visual line, by binary search over the prefix
  // sums built by computeMetrics().
  function logicalLineFromVisual(visual) {
    var prefix = metrics.prefix;
    if (prefix.length < 2) {
      return 0;
    }
    var low = 0;
    var high = prefix.length - 1;
    while (low < high) {
      var middle = (low + high + 1) >> 1;
      if (prefix[middle] <= visual) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  }

  // The inverse: a float logical line turned into a visual line.
  function visualFromLogicalLine(position) {
    var counts = metrics.counts;
    if (!counts.length) {
      return 0;
    }
    var line = Math.floor(position);
    var fraction = position - line;
    if (line >= counts.length) {
      line = counts.length - 1;
      fraction = 1;
    } else if (line < 0) {
      line = 0;
      fraction = 0;
    }
    var span = counts[line] > 0 ? counts[line] : 1;
    return metrics.prefix[line] + fraction * span;
  }

  // Source line -> where the preview should be scrolled to, or null.
  function previewTopForLine(line) {
    if (!anchors.length) {
      return null;
    }
    var low = 0;
    var high = anchors.length - 1;
    var index = 0;
    while (low <= high) {
      var middle = (low + high) >> 1;
      if (anchors[middle].line <= line) {
        index = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    var current = anchors[index];
    var next = anchors[index + 1];
    var top = current.top;
    if (next) {
      var span = next.line - current.line;
      var fraction = span > 0 ? clamp((line - current.line) / span, 0, 1) : 0;
      top += fraction * (next.top - current.top);
    }
    return top;
  }

  // Preview scroll offset -> the source line at the top edge, or null.
  function lineForPreviewTop(top) {
    if (!anchors.length) {
      return null;
    }
    var low = 0;
    var high = anchors.length - 1;
    var index = 0;
    while (low <= high) {
      var middle = (low + high) >> 1;
      if (anchors[middle].top <= top) {
        index = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    var current = anchors[index];
    var next = anchors[index + 1];
    var line = current.line;
    if (next) {
      var span = next.top - current.top;
      var fraction = span > 0 ? clamp((top - current.top) / span, 0, 1) : 0;
      line += fraction * (next.line - current.line);
    }
    return line;
  }

  /* --- remembering the reading position ------------------------------------ */

  // An offset in pixels means nothing after the layout has changed: a zoom, a
  // re-wrap, a switch between the views or a reload all move the same offset to
  // a different line.  The source line at the top edge of the pane means the
  // same thing in all of them, so that is what every action carries across.
  //
  // The pane that owns the position is the one the user is reading: the preview
  // in the preview-only view, the editor otherwise.  In the split view the two
  // are kept in step, so either one reads the same place.
  function placePane() {
    return state.settings.viewMode === 'preview' ? previewViewport : editor;
  }

  function placeFromPane(pane) {
    if (pane === previewViewport) {
      ensureAnchors();
      var line = lineForPreviewTop(previewViewport.scrollTop);
      if (line !== null) {
        return { line: line };
      }
      var previewLimit = maxScroll(previewViewport);
      return { ratio: previewLimit > 0 ? previewViewport.scrollTop / previewLimit : 0 };
    }
    computeMetrics();
    return { line: logicalLineFromVisual(editorVisualTop()) };
  }

  function rememberPlace(pane) {
    currentPlace = placeFromPane(pane || placePane());
  }

  // Puts the active pane back at a place.  A document with no anchors falls
  // back to the fraction of the scroll range, which is the best that can be
  // said about a page of unpaired blocks.
  function applyPlace(place) {
    if (!place) {
      return;
    }
    if (placePane() === previewViewport) {
      ensureAnchors();
      var limit = maxScroll(previewViewport);
      var top = typeof place.line === 'number' ? previewTopForLine(place.line) : null;
      if (top === null && typeof place.ratio === 'number') {
        top = place.ratio * limit;
      }
      if (top === null) {
        return;
      }
      programmatic.preview = Math.round(clamp(top, 0, limit));
      previewViewport.scrollTop = programmatic.preview;
      programmatic.preview = previewViewport.scrollTop;
    } else {
      computeMetrics();
      var target = null;
      if (typeof place.line === 'number') {
        target = visualFromLogicalLine(place.line) *
                 (metrics.lineHeight > 0 ? metrics.lineHeight : 1);
      } else if (typeof place.ratio === 'number') {
        target = place.ratio * maxScroll(editor);
      }
      if (target === null) {
        return;
      }
      programmatic.editor = Math.round(clamp(target, 0, maxScroll(editor)));
      editor.scrollTop = programmatic.editor;
      programmatic.editor = editor.scrollTop;
      if (state.settings.viewMode === 'split') {
        // The preview shows the same place; in the editor-only view it is
        // hidden and has nothing to follow.
        syncFromEditor();
      }
    }
    rememberPlace();
  }

  // Marks a place to restore once the layout an action is about to change has
  // settled.  Until then the panes' scroll events are the browser clamping a
  // shrinking or hidden area, not the reader moving, so they are dropped
  // instead of being remembered (see the scroll handlers).
  function holdPlace(place) {
    pendingPlace = place || placeFromPane(placePane());
    if (pendingPlaceTimer) {
      clearTimeout(pendingPlaceTimer);
    }
    // A zoom already at its limit changes nothing and fires no resize; this is
    // what releases the hold in that case.
    pendingPlaceTimer = setTimeout(settlePlace, PLACE_HOLD_MS);
  }

  // Applies the held place, or the last remembered one, to the current layout.
  function settlePlace() {
    var place = pendingPlace || currentPlace;
    pendingPlace = null;
    if (pendingPlaceTimer) {
      clearTimeout(pendingPlaceTimer);
      pendingPlaceTimer = null;
    }
    if (place) {
      applyPlace(place);
    } else {
      syncFromEditor();
    }
  }

  // Every zoom request starts here, so the reading position is read before the
  // host changes the zoom factor and the layout moves under it.
  function requestZoom(type) {
    holdPlace();
    postToHost({ type: type });
  }

  /* --- moving the other pane --------------------------------------------- */

  function syncFromEditor() {
    programmatic.editor = editor.scrollTop;
    computeMetrics();
    ensureAnchors();

    var limit = maxScroll(previewViewport);
    var target = null;
    if (anchors.length) {
      target = previewTopForLine(logicalLineFromVisual(editorVisualTop()));
    }
    if (target === null) {
      var editorRange = maxScroll(editor);
      var ratio = editorRange > 0 ? clamp(editor.scrollTop / editorRange, 0, 1) : 0;
      target = ratio * limit;
    }

    target = Math.round(clamp(target, 0, limit));
    programmatic.preview = target;
    previewViewport.scrollTop = target;
    // The browser may clamp: record what actually happened so the preview's own
    // scroll handler does not treat this as a user scroll and bounce back.
    programmatic.preview = previewViewport.scrollTop;
  }

  function syncFromPreview() {
    programmatic.preview = previewViewport.scrollTop;
    computeMetrics();
    ensureAnchors();

    var limit = maxScroll(editor);
    var target = null;
    if (anchors.length) {
      var line = lineForPreviewTop(previewViewport.scrollTop);
      if (line !== null) {
        target = visualFromLogicalLine(line) * (metrics.lineHeight > 0 ? metrics.lineHeight : 1);
      }
    }
    if (target === null) {
      var previewRange = maxScroll(previewViewport);
      var ratio = previewRange > 0 ? clamp(previewViewport.scrollTop / previewRange, 0, 1) : 0;
      target = ratio * limit;
    }

    target = Math.round(clamp(target, 0, limit));
    programmatic.editor = target;
    editor.scrollTop = target;
    programmatic.editor = editor.scrollTop;
  }

  // One entry point for "this pane moved, follow with the other one".
  function syncScrollFrom(source) {
    if (source === previewViewport) {
      syncFromPreview();
    } else {
      syncFromEditor();
    }
  }

  /* --- scroll to top and bottom ------------------------------------------- */

  // The pair in the bottom right corner appears while the reader scrolls and
  // fades out a second after the last move.  It drives the pane that owns the
  // reading position - the preview in the preview-only view, the editor
  // otherwise - so a jump is just another deliberate move, like a find jump,
  // and leaves the other pane and the remembered place in step.
  function jumpAtEdge(edge) {
    var pane = placePane();
    var limit = maxScroll(pane);
    if (limit <= JUMP_EDGE_PX) {
      // The document fits the pane: neither end can be reached, so both
      // buttons read as unavailable.
      return true;
    }
    return edge === 'top'
      ? pane.scrollTop <= JUMP_EDGE_PX
      : pane.scrollTop >= limit - JUMP_EDGE_PX;
  }

  function paintJumpButtons() {
    jumpTopButton.setAttribute('aria-disabled', jumpAtEdge('top') ? 'true' : 'false');
    jumpBottomButton.setAttribute('aria-disabled', jumpAtEdge('bottom') ? 'true' : 'false');
  }

  function scheduleJumpHide() {
    if (jumpHideTimer) {
      clearTimeout(jumpHideTimer);
    }
    jumpHideTimer = setTimeout(function () {
      jumpHideTimer = null;
      // Never pull the pair out from under the pointer or the keyboard: the
      // reader is on their way to click one.
      if (jumpButtons.matches(':hover') || jumpButtons.contains(document.activeElement)) {
        scheduleJumpHide();
        return;
      }
      jumpButtons.classList.remove('is-visible');
    }, JUMP_HIDE_MS);
  }

  // Called by the scroll handlers on a move the reader made.
  function revealJumpButtons() {
    paintJumpButtons();
    jumpButtons.classList.add('is-visible');
    scheduleJumpHide();
  }

  // The dim state follows the pane while it moves, so the button for the end
  // already reached is inactive by the time the reader looks at it.
  function followJumpScroll() {
    if (jumpButtons.classList.contains('is-visible')) {
      paintJumpButtons();
    }
  }

  function jumpTo(edge) {
    if (jumpAtEdge(edge)) {
      return;
    }
    var pane = placePane();
    var target = edge === 'top' ? 0 : maxScroll(pane);
    programmatic[pane === previewViewport ? 'preview' : 'editor'] = target;
    // A smooth scroll reports itself through the scroll handlers, which keeps
    // the place and the other pane in step exactly as a wheel does.  The check
    // afterwards covers a browser that lands at once instead: its single
    // event matches the target and looks programmatic, so do the work here.
    try {
      pane.scrollTo({ top: target, behavior: 'smooth' });
    } catch (error) {
      pane.scrollTop = target;
    }
    if (Math.abs(pane.scrollTop - target) < 1) {
      if (pane === previewViewport) {
        syncFromPreview();
      } else {
        syncFromEditor();
      }
      rememberPlace(pane);
    }
    revealJumpButtons();
  }

  // A "#fn-1" link inside the preview is a jump within the document, not a
  // navigation.  Letting the browser follow it scrolls the page's <body>, which
  // must never move - it takes the whole window with it - and leaves "#fn-1" in
  // the address.  So the link is caught here and only the preview pane scrolls.
  function scrollPreviewToFragment(href) {
    var id = href.slice(1);
    if (!id) {
      return;
    }
    try {
      id = decodeURIComponent(id);
    } catch (error) {
      /* a name that is not valid percent-encoding is used as it stands */
    }
    var target = document.getElementById(id);
    if (!target || !markdown.contains(target)) {
      return;
    }
    var offset = target.getBoundingClientRect().top - previewViewport.getBoundingClientRect().top;
    var top = clamp(previewViewport.scrollTop + offset, 0, maxScroll(previewViewport));
    programmatic.preview = top;
    try {
      previewViewport.scrollTo({ top: top, behavior: 'smooth' });
    } catch (error) {
      previewViewport.scrollTop = top;
    }
    if (Math.abs(previewViewport.scrollTop - top) < 1) {
      syncFromPreview();
      rememberPlace(previewViewport);
    }
  }

  // Any other link in the document is followed outside the window: the page is
  // the program, so letting the embedded browser navigate would replace it with
  // a web page, or with a 404 from the assets the program serves itself.  An
  // address with a scheme goes to the reader's own browser, and a name relative
  // to the document is resolved to a file, which the host opens in a tab when it
  // is a document and in whatever program owns it otherwise.
  function followLink(href) {
    var address = String(href || '').trim();
    if (!address || /^(?:javascript|vbscript|data):/i.test(address)) {
      return;  // never a link this program will act on
    }
    // A drive letter looks like a scheme ("E:"), so it is told apart first.
    if (/^[a-z][a-z0-9+.-]*:/i.test(address) && !/^[A-Za-z]:[\\/]/.test(address)) {
      postToHost({ type: 'openLink', url: address });
      return;
    }
    var path = resolveLocalPath(address);
    if (!path) {
      showToast('Save the document to follow a relative link', true);
      return;
    }
    postToHost({ type: 'openLink', url: path });
  }

  function initJumpButtons() {
    jumpTopButton.addEventListener('click', function () {
      jumpTo('top');
    });
    jumpBottomButton.addEventListener('click', function () {
      jumpTo('bottom');
    });

    // The pair sits on top of the text, so the wheel over it has to keep
    // scrolling the document instead of hitting a dead corner.
    jumpButtons.addEventListener('wheel', function (event) {
      if (!event.deltaY) {
        return;
      }
      var pane = placePane();
      var scale = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? pane.clientHeight : 1);
      pane.scrollTop += event.deltaY * scale;
      event.preventDefault();
    }, { passive: false });

    jumpButtons.addEventListener('pointerenter', function () {
      if (jumpHideTimer) {
        clearTimeout(jumpHideTimer);
        jumpHideTimer = null;
      }
    });
    jumpButtons.addEventListener('pointerleave', function () {
      if (jumpButtons.classList.contains('is-visible')) {
        scheduleJumpHide();
      }
    });
    jumpButtons.addEventListener('focusin', function () {
      if (jumpHideTimer) {
        clearTimeout(jumpHideTimer);
        jumpHideTimer = null;
      }
    });
    jumpButtons.addEventListener('focusout', function () {
      if (jumpButtons.classList.contains('is-visible')) {
        scheduleJumpHide();
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Tabs                                                                   */
  /* ---------------------------------------------------------------------- */

  function activeTab() {
    return state.tabs[state.active] || null;
  }

  // The editor is the live copy of the active tab's text, so anything that is
  // about to replace what the editor shows has to copy it back first.
  function syncEditorIntoTab() {
    var tab = activeTab();
    if (!tab) {
      return;
    }
    tab.text = editor.value;
    tab.scrollTop = editor.scrollTop;
    tab.previewTop = previewViewport.scrollTop;
    tab.selStart = editor.selectionStart;
    tab.selEnd = editor.selectionEnd;
  }

  // Hands the host the newest text of the active tab when it is dirty, so a
  // crash or a kill cannot lose more than the last keystrokes.
  function flushSnapshot() {
    var tab = activeTab();
    if (tab && tab.dirty) {
      postToHost({ type: 'snapshot', index: state.active, content: editor.value,
        generation: state.tabGeneration });
    }
  }

  function showTab(index, syncCurrent, focusEditor) {
    if (syncCurrent !== false) {
      syncEditorIntoTab();
      flushSnapshot();
    }
    state.active = clamp(index, 0, Math.max(0, state.tabs.length - 1));
    var tab = activeTab();
    if (!tab) {
      editor.value = '';
      currentPlace = null;
      updateTabStrip();
      return;
    }
    editor.value = tab.text;
    metrics.text = null;
    programmatic.editor = tab.scrollTop;
    programmatic.preview = tab.previewTop;
    editor.scrollTop = tab.scrollTop;
    previewViewport.scrollTop = tab.previewTop;
    if (typeof tab.selStart === 'number') {
      editor.setSelectionRange(tab.selStart, Math.max(tab.selStart, tab.selEnd));
    }
    renderNow();
    if (state.settings.viewMode === 'preview') {
      // The offset was set while the previous document was still on screen, so
      // it was clamped to that document's height.  renderNow() kept whatever it
      // could; now the new document has its real height, the tab's own place is
      // applied again.
      previewViewport.scrollTop = tab.previewTop;
    }
    programmatic.editor = editor.scrollTop;
    programmatic.preview = previewViewport.scrollTop;
    // The tab remembers its offset in pixels from when it was left; the place
    // that offset stands for is what a zoom, a view switch or a reload keeps.
    rememberPlace();
    updateTabStrip();
    updateFileStatus();
    if (find.open) {
      refreshFindMatches(true);
    }
    if (focusEditor) {
      editor.focus();
    }
  }

  function selectTab(index, focusEditor) {
    if (index < 0 || index >= state.tabs.length) {
      return;
    }
    if (index === state.active) {
      updateTabStrip();
      return;
    }
    showTab(index, true, Boolean(focusEditor));
    postToHost({ type: 'tabSelect', index: state.active });
  }

  function cycleTab(delta) {
    var count = state.tabs.length;
    if (count < 2) {
      return;
    }
    selectTab(((state.active + delta) % count + count) % count, true);
  }

  // Asks the host to close a tab.  The text travels with the request, so the
  // host can prompt about unsaved changes without talking to the page again.
  function requestCloseTab(index) {
    if (index < 0 || index >= state.tabs.length) {
      return;
    }
    syncEditorIntoTab();
    postToHost({ type: 'tabClose', index: index, content: state.tabs[index].text });
  }

  // The host has accepted the close (and prompted if it had to): drop the tab.
  function closeTabLocally(index, active) {
    if (index < 0 || index >= state.tabs.length) {
      return;
    }
    var current = activeTab();
    if (index !== state.active) {
      syncEditorIntoTab();
    }
    state.tabs.splice(index, 1);
    if (!state.tabs.length) {
      state.tabs.push(blankTab());
    }
    state.active = clamp(typeof active === 'number' ? active : index, 0, state.tabs.length - 1);
    if (state.tabs[state.active] === current) {
      // The tab on screen survived: leave the editor exactly as it is and only
      // tidy up the strip, otherwise closing a background tab would jump the
      // user's scroll position around.
      updateTabStrip();
      updateFileStatus();
    } else {
      showTab(state.active, false, false);
    }
    if (find.open) {
      refreshFindMatches(false);
    }
  }

  // "Close other tabs": the tab that stays keeps its text, the rest are dropped
// without a round trip.
function collapseTabs(keep) {
    if (keep < 0 || keep >= state.tabs.length) {
      return;
    }
    var current = activeTab();
    syncEditorIntoTab();
    var survivor = state.tabs[keep];
    state.tabs = [survivor];
    state.active = 0;
    if (survivor === current) {
      // The tab on screen is the one that stayed: leave the editor alone.
      updateTabStrip();
      updateFileStatus();
    } else {
      showTab(0, false, false);
    }
    if (find.open) {
      refreshFindMatches(false);
    }
  }

  // Tab list (names, paths, which one is active) sent by the host whenever the
  // set of files changes.  The text of the tabs is *not* touched here: the page
  // is the only place where live text lives.
  function reconcileTabs(data) {
    var items = data.items || [];
    if (typeof data.generation === 'number') {
      state.tabGeneration = data.generation;
    }
    // The list from the host is the whole truth: tabs past its end no longer
    // exist (that is how "close all tabs" and "close other tabs" arrive).
    if (state.tabs.length > items.length) {
      state.tabs.length = items.length;
      if (!state.tabs.length) {
        state.tabs.push(blankTab());
      }
      if (state.active >= state.tabs.length) {
        state.active = state.tabs.length - 1;
      }
    }
    for (var index = 0; index < items.length; index++) {
      var item = items[index] || {};
      if (!state.tabs[index]) {
        state.tabs[index] = blankTab(item.name);
      }
      var tab = state.tabs[index];
      if (item.name) {
        tab.name = item.name;
      }
      if (typeof item.path === 'string') {
        tab.path = item.path;
      }
    }
    if (typeof data.active === 'number' && data.active >= 0 && data.active < state.tabs.length &&
        data.active !== state.active) {
      showTab(data.active, true, false);
    } else {
      updateTabStrip();
      updateFileStatus();
    }
  }

  // The host handed over the text of one tab: open (or reload) it.
  function applyHostDocument(data) {
    bootLoaded = true;
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    var index = (typeof data.index === 'number' && data.index >= 0) ? data.index : 0;
    syncEditorIntoTab();
    while (state.tabs.length <= index) {
      state.tabs.push(blankTab());
    }
    var tab = state.tabs[index];
    // "Reload from Disk" hands the same file back while its tab is the one on
    // screen: the reader keeps their place, at the same source line, across the
    // new text.  Opening a file, creating a tab or filling another tab starts
    // at the top.
    var path = (typeof data.path === 'string') ? data.path : '';
    var reloading = index === state.active && path !== '' && tab.path !== '' &&
                    path.toLowerCase() === tab.path.toLowerCase();
    var keepPlace = reloading ? placeFromPane(placePane()) : null;
    tab.text = (typeof data.content === 'string') ? data.content : '';
    tab.path = path;
    tab.name = data.name || 'Untitled.md';
    tab.dirty = Boolean(data.dirty);
    tab.scrollTop = 0;
    tab.previewTop = 0;
    tab.selStart = 0;
    tab.selEnd = 0;
    state.active = index;
    showTab(index, false, false);
    editor.setSelectionRange(0, 0);
    updateCursorStatus();
    if (find.open) {
      refreshFindMatches(false);
    }
    try {
      editor.focus();
    } catch (error) {
      /* ignore */
    }
    if (keepPlace) {
      // Focusing put the caret, which the reload reset to the start, in view;
      // the reading position goes back on top of that.
      if (pendingPlaceTimer) {
        clearTimeout(pendingPlaceTimer);
        pendingPlaceTimer = null;
      }
      pendingPlace = null;
      applyPlace(keepPlace);
    }
  }

  function applySaved(data) {
    var index = (typeof data.index === 'number') ? data.index : state.active;
    var tab = state.tabs[index];
    if (!tab) {
      return;
    }
    if (data.path) {
      tab.path = data.path;
    }
    if (data.name) {
      tab.name = data.name;
    }
    tab.dirty = false;
    updateTabStrip();
    updateFileStatus();
    showToast('Saved ' + tab.name, false);
    // Save As moves the document, and a picture named relative to it now
    // resolves somewhere else.
    applyLocalImages(markdown);
  }

  function postAllContents(reason) {
    syncEditorIntoTab();
    state.tabs.forEach(function (tab, index) {
      postToHost({
        type: 'content',
        reason: reason,
        index: index,
        content: tab.text || ''
      });
    });
  }

  // Dragging a tab sideways moves it in the strip.  Plain mouse events rather
  // than HTML5 drag and drop: the host registers an OLE drop target of its own
  // on the window for file drops, and a drag that stays inside the page has no
  // business going near it.  The tab follows the pointer live, so there is no
  // separate drop indicator to keep in sync.
  var tabDrag = null;   // { tab, startX, startY, moving } between down and up
  var middlePressTab = null;  // the tab a middle button went down on, until it comes up

  // The gap in the strip the pointer is over, counted in tabs to its left, or
  // -1 while it is not over a tab at all.
  function tabInsertionIndex(clientX, clientY) {
    var element = document.elementFromPoint(clientX, clientY);
    if (!element || !element.closest) {
      return -1;
    }
    var hit = element.closest('.tab');
    if (!hit || !tabList.contains(hit)) {
      return -1;
    }
    var index = Number(hit.getAttribute('data-index'));
    if (!(index >= 0)) {
      return -1;
    }
    // Past the middle of the tab means "after it", which is what makes a swap
    // happen as the pointer crosses over rather than only on a full-width move.
    var box = hit.getBoundingClientRect();
    return clientX > box.left + box.width / 2 ? index + 1 : index;
  }

  function moveDraggedTab(before) {
    if (!tabDrag) {
      return;
    }
    var from = state.tabs.indexOf(tabDrag.tab);
    if (from < 0) {
      return;
    }
    // `before` counts gaps in the list as it stands, and the dragged tab is
    // still one of its items, so a move to the right loses one.
    var to = before > from ? before - 1 : before;
    if (to === from || to < 0 || to > state.tabs.length - 1) {
      return;
    }
    var active = activeTab();
    state.tabs.splice(from, 1);
    state.tabs.splice(to, 0, tabDrag.tab);
    state.active = Math.max(0, state.tabs.indexOf(active));
    updateTabStrip();
    // The host keeps the same order, so closing a tab, "close others" and the
    // saved session all still mean the same tabs.
    postToHost({ type: 'tabReorder', from: from, to: to, active: state.active });
  }

  function onTabDragMove(event) {
    if (!tabDrag) {
      return;
    }
    if (!tabDrag.moving) {
      var dx = Math.abs(event.clientX - tabDrag.startX);
      var dy = Math.abs(event.clientY - tabDrag.startY);
      if (dx < 4 && dy < 4) {
        return;   // still a click, not a drag
      }
      tabDrag.moving = true;
      if (tabStrip) {
        tabStrip.classList.add('is-reordering');
      }
      updateTabStrip();
    }
    // Near either end of a strip that overflows, keep the hidden tabs coming.
    if (tabScroller.scrollWidth > tabScroller.clientWidth) {
      var view = tabScroller.getBoundingClientRect();
      var right = view.right - tabAdd.offsetWidth;
      if (event.clientX < view.left + 26) {
        tabScroller.scrollLeft -= 18;
      } else if (event.clientX > right - 26) {
        tabScroller.scrollLeft += 18;
      }
    }
    var before = tabInsertionIndex(event.clientX, event.clientY);
    if (before >= 0) {
      moveDraggedTab(before);
    }
  }

  function endTabDrag() {
    if (!tabDrag) {
      return;
    }
    tabDrag = null;
    if (tabStrip) {
      tabStrip.classList.remove('is-reordering');
    }
    updateTabStrip();
  }

  // A middle click closes the tab, on release and only when the release lands
  // on the tab the press started on.  A press that slides off, or a window that
  // loses the pointer, closes nothing.
  function endTabPress(event) {
    if (!middlePressTab) {
      return;
    }
    var pressed = middlePressTab;
    middlePressTab = null;
    var over = event.target && event.target.closest ? event.target.closest('.tab') : null;
    if (over !== pressed) {
      return;
    }
    requestCloseTab(Number(pressed.getAttribute('data-index')));
  }

  // The strip reserves room for the horizontal scrollbar only while the tabs
  // overflow; updateTabStrip refreshes this after every change to the list.
  function updateTabOverflow() {
    if (!tabStrip || !tabScroller) {
      return;
    }
    tabStrip.classList.toggle('has-scrollbar',
                             tabScroller.scrollWidth > tabScroller.clientWidth + 1);
  }

  function updateTabStrip() {
    var dragging = (tabDrag && tabDrag.moving) ? tabDrag.tab : null;
    var html = '';
    for (var index = 0; index < state.tabs.length; index++) {
      var tab = state.tabs[index];
      var name = tab.name || 'Untitled.md';
      var isActive = (index === state.active);
      html += '<div class="tab' + (isActive ? ' is-active' : '') + (tab.dirty ? ' is-dirty' : '') +
              (tab === dragging ? ' is-dragging' : '') +
              '" role="tab" data-index="' + index + '" aria-selected="' + (isActive ? 'true' : 'false') +
              '" title="' + escapeHtml(tab.path || name) + '">' +
              '<svg class="tab-icon" viewBox="0 0 16 16" aria-hidden="true">' +
              '<path d="M4 1.8h5.2L12.6 5.2v9H4z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>' +
              '<path d="M9.1 1.9v3.5h3.4" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>' +
              '</svg>' +
              '<span class="tab-label">' + escapeHtml(name) + '</span>' +
              '<button type="button" class="tab-close" tabindex="-1" title="Close (Ctrl+W)"' +
              ' aria-label="Close ' + escapeHtml(name) + '">&#215;</button>' +
              '</div>';
    }
    tabList.innerHTML = html;
    tabAdd.disabled = state.tabs.length >= 96;
    // Keep a tab in view, leaving the pinned + button its width.  While a drag
    // is running that is the tab under the pointer, so the strip follows it
    // instead of jumping back to the active one on every move.
    var keepInView = dragging ? tabList.querySelector('.tab.is-dragging')
                              : tabList.querySelector('.tab.is-active');
    if (keepInView) {
      var view = tabScroller.getBoundingClientRect();
      var box = keepInView.getBoundingClientRect();
      var pinned = tabAdd.offsetWidth;
      if (box.right > view.right - pinned) {
        tabScroller.scrollLeft += box.right - (view.right - pinned);
      } else if (box.left < view.left) {
        tabScroller.scrollLeft -= view.left - box.left;
      }
    }
    updateTabOverflow();
  }

  /* ---------------------------------------------------------------------- */
  /* Dirty flag and the buffer mirror                                       */
  /* ---------------------------------------------------------------------- */

  function setDirty(value) {
    var tab = activeTab();
    if (!tab) {
      return;
    }
    var next = Boolean(value);
    if (tab.dirty === next) {
      return;
    }
    tab.dirty = next;
    updateFileStatus();
    updateTabStrip();
    postToHost({ type: 'dirty', index: state.active, value: next,
      generation: state.tabGeneration });
    if (next) {
      scheduleSnapshot();
    }
  }

  function scheduleSnapshot() {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
    }
    snapshotTimer = setTimeout(function () {
      snapshotTimer = null;
      var tab = activeTab();
      if (tab && tab.dirty) {
        postToHost({ type: 'snapshot', index: state.active, content: editor.value,
          generation: state.tabGeneration });
      }
    }, SNAPSHOT_DELAY_MS);
  }

  // Every path that changes the buffer outside of plain typing goes through
  // here, so the tab, the host and the renderer stay in step.
  function markEdited() {
    metrics.text = null;
    syncEditorIntoTab();
    setDirty(true);
    scheduleSnapshot();
    scheduleRender();
  }

  function insertTextAtCursor(text) {
    if (!text) {
      return;
    }
    editor.focus();
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    var inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch (error) {
      inserted = false;
    }
    if (!inserted) {
      var value = editor.value;
      editor.value = value.slice(0, start) + text + value.slice(end);
      editor.setSelectionRange(start + text.length, start + text.length);
    }
    markEdited();
    updateCounts();
  }

  function replaceSelectionWith(text) {
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    var inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch (error) {
      inserted = false;
    }
    if (!inserted) {
      var value = editor.value;
      editor.value = value.slice(0, start) + text + value.slice(end);
      editor.setSelectionRange(start + text.length, start + text.length);
    }
    markEdited();
    updateCounts();
  }

  /* ---------------------------------------------------------------------- */
  /* Formatting bar                                                         */
  /* ---------------------------------------------------------------------- */

  // Every action below ends in exactly one replaceEditorRange call, so one
  // Ctrl+Z takes the whole change back, however many lines it touched.  The
  // helpers work out the new text and the selection to leave behind first.
  function replaceEditorRange(start, end, text, selectionStart, selectionEnd) {
    editor.focus();
    editor.setSelectionRange(start, end);
    var inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch (error) {
      inserted = false;
    }
    if (!inserted) {
      var value = editor.value;
      editor.value = value.slice(0, start) + text + value.slice(end);
    }
    var from = (typeof selectionStart === 'number') ? selectionStart : start + text.length;
    var to = (typeof selectionEnd === 'number') ? selectionEnd : from;
    editor.setSelectionRange(Math.max(0, from), Math.max(from, to));
    markEdited();
    updateCounts();
  }

  // Bold, italic and friends: wrapping a selection that already carries the
  // markers takes them away again, and the text stays selected either way, so
  // the next button press applies to the same words.
  function formatWrap(open, close, placeholder) {
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    var value = editor.value;
    var selected = value.slice(start, end);
    var before = value.slice(Math.max(0, start - open.length), start);
    var after = value.slice(end, end + close.length);

    // One asterisk is italic and two are bold, so a run of them has to be read
    // as a whole: Ctrl+I inside "**words**" adds a third asterisk, while inside
    // "***words***" it takes one away again.
    if (open === '*' && close === '*') {
      var beforeRun = 0;
      var afterRun = 0;
      var scan;
      for (scan = start - 1; scan >= 0 && value.charAt(scan) === '*'; --scan) {
        ++beforeRun;
      }
      for (scan = end; scan < value.length && value.charAt(scan) === '*'; ++scan) {
        ++afterRun;
      }
      if (selected.length > 0) {
        var leading = 0;
        var trailing = 0;
        for (scan = 0; scan < selected.length && selected.charAt(scan) === '*'; ++scan) {
          ++leading;
        }
        for (scan = selected.length - 1; scan >= 0 && selected.charAt(scan) === '*'; --scan) {
          ++trailing;
        }
        if (leading > 0 && leading % 2 === 1 && trailing > 0 && trailing % 2 === 1) {
          var unwrapped = selected.slice(1, selected.length - 1);
          replaceEditorRange(start, end, unwrapped, start, start + unwrapped.length);
          return;
        }
      }
      if (selected.length > 0 && beforeRun > 0 && afterRun > 0) {
        if (beforeRun % 2 === 1 && afterRun % 2 === 1) {
          replaceEditorRange(start - 1, end + 1, selected, start - 1, start - 1 + selected.length);
        } else {
          replaceEditorRange(start, end, '*' + selected + '*', start + 1, start + 1 + selected.length);
        }
        return;
      }
    }

    if (selected.length >= open.length + close.length &&
        selected.slice(0, open.length) === open &&
        selected.slice(selected.length - close.length) === close) {
      var inner = selected.slice(open.length, selected.length - close.length);
      replaceEditorRange(start, end, inner, start, start + inner.length);
      return;
    }
    if (selected.length > 0 && before === open && after === close) {
      replaceEditorRange(start - open.length, end + close.length, selected,
                         start - open.length, start - open.length + selected.length);
      return;
    }
    var body = selected || placeholder || '';
    replaceEditorRange(start, end, open + body + close,
                       start + open.length, start + open.length + body.length);
  }

  // The whole lines a block action works on, plus where the caret sits in them.
  // A selection that stops at a line start leaves that next line alone.
  function currentLineBlock() {
    var value = editor.value;
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    var blockStart = value.lastIndexOf('\n', start - 1) + 1;
    var blockEnd;
    if (end > start && value.charAt(end - 1) === '\n') {
      blockEnd = end - 1;
    } else {
      blockEnd = value.indexOf('\n', end);
      if (blockEnd < 0) {
        blockEnd = value.length;
      }
    }
    var lines = value.slice(blockStart, blockEnd).split('\n');
    var caretLine = value.slice(blockStart, start).split('\n').length - 1;
    var caretLineStart = blockStart;
    for (var index = 0; index < caretLine; ++index) {
      caretLineStart += lines[index].length + 1;
    }
    return {
      start: blockStart,
      end: blockEnd,
      lines: lines,
      caretLine: caretLine,
      caretColumn: Math.max(0, start - caretLineStart)
    };
  }

  // Puts transformed lines back, moving the selection with them: a prefix added
  // or removed at the start of a line shifts every column after it, and the
  // user keeps the same words selected they had before the button was pressed.
  function replaceLineBlock(block, lines) {
    var oldLines = block.lines;
    var oldStarts = [];
    var newStarts = [];
    var cursor = block.start;
    var index;
    for (index = 0; index < oldLines.length; ++index) {
      oldStarts.push(cursor);
      cursor += oldLines[index].length + 1;
    }
    cursor = block.start;
    for (index = 0; index < lines.length; ++index) {
      newStarts.push(cursor);
      cursor += lines[index].length + 1;
    }
    var mapOffset = function (offset) {
      var line = 0;
      while (line + 1 < oldLines.length && offset >= oldStarts[line + 1]) {
        ++line;
      }
      var delta = lines[line].length - oldLines[line].length;
      var column = Math.min(Math.max(0, offset - oldStarts[line] + delta), lines[line].length);
      return newStarts[line] + column;
    };
    var text = lines.join('\n');
    var from = mapOffset(editor.selectionStart);
    var to = Math.max(from, mapOffset(editor.selectionEnd));
    replaceEditorRange(block.start, block.end, text, from, to);
  }

  function formatHeading(level) {
    var block = currentLineBlock();
    var marker = '';
    for (var count = 0; count < level; ++count) {
      marker += '#';
    }
    var pattern = /^(\s{0,3})(#{1,6})([ \t]+)/;
    var hasLevel = function (line) {
      var match = pattern.exec(line);
      return match !== null && match[2].length === level;
    };
    var filled = block.lines.filter(function (line) {
      return line.trim() !== '';
    });
    var all = filled.length > 0 && filled.every(hasLevel);
    var lines = block.lines.map(function (line) {
      var match = pattern.exec(line);
      if (all) {
        return match ? line.replace(pattern, '$1') : line;
      }
      if (line.trim() === '' && block.lines.length > 1) {
        return line;
      }
      return match ? line.replace(pattern, '$1' + marker + '$3') : marker + ' ' + line;
    });
    replaceLineBlock(block, lines);
  }

  function formatQuote() {
    var block = currentLineBlock();
    var quoted = /^(\s*)>[ \t]?/;
    var all = block.lines.every(function (line) {
      return line.trim() === '' || quoted.test(line);
    });
    var lines = block.lines.map(function (line) {
      if (all) {
        return line.replace(quoted, '$1');
      }
      if (line.trim() === '') {
        return '> ';
      }
      return quoted.test(line) ? line : '> ' + line;
    });
    replaceLineBlock(block, lines);
  }

  // "- item", "1. item" and "- [ ] item" share one shape; read it apart once.
  function listMarker(line) {
    var match = /^(\s*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?/.exec(line);
    if (!match) {
      return null;
    }
    return {
      indent: match[1],
      mark: match[2],
      gap: match[3],
      task: match[4] || '',
      length: match[0].length
    };
  }

  function formatList(kind) {
    var block = currentLineBlock();
    var filled = block.lines.filter(function (line) {
      return line.trim() !== '';
    });
    var all = filled.length > 0 && filled.every(function (line) {
      var marker = listMarker(line);
      if (!marker) {
        return false;
      }
      if (kind === 'task') {
        return marker.task !== '';
      }
      if (kind === 'bullet') {
        return marker.task === '' && /^[-*+]$/.test(marker.mark);
      }
      return marker.task === '' && /^\d/.test(marker.mark);
    });
    var counter = 0;
    var lines = block.lines.map(function (line) {
      var marker = listMarker(line);
      if (all) {
        return marker ? marker.indent + line.slice(marker.length) : line;
      }
      if (line.trim() === '') {
        return line;
      }
      var rest = marker ? line.slice(marker.length) : line;
      var indent = marker ? marker.indent : '';
      if (kind === 'bullet') {
        return indent + '- ' + rest;
      }
      if (kind === 'task') {
        var box = (marker && marker.task) ? marker.task : '[ ] ';
        return indent + '- ' + box + rest;
      }
      counter += 1;
      return indent + counter + '. ' + rest;
    });
    replaceLineBlock(block, lines);
  }

  function formatCodeBlock() {
    var value = editor.value;
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    var blockStart = value.lastIndexOf('\n', start - 1) + 1;
    var blockEnd;
    if (end > start && value.charAt(end - 1) === '\n') {
      blockEnd = end - 1;
    } else {
      blockEnd = value.indexOf('\n', end);
      if (blockEnd < 0) {
        blockEnd = value.length;
      }
    }
    var block = value.slice(blockStart, blockEnd);
    var lines = block.split('\n');
    if (lines.length >= 2 && /^```/.test(lines[0]) &&
        /^\s*```\s*$/.test(lines[lines.length - 1])) {
      var inner = lines.slice(1, -1).join('\n');
      replaceEditorRange(blockStart, blockEnd, inner, blockStart, blockStart + inner.length);
      return;
    }
    var caret = blockStart + (start - blockStart) + 4;
    var selectionEnd = blockStart + (end - blockStart) + 4;
    replaceEditorRange(blockStart, blockEnd, '```\n' + block + '\n```',
                       caret, Math.max(caret, selectionEnd));
  }

  // A block that has to stand on its own line, separated from the paragraph
  // around it.  `selection` is the part of it to leave selected.
  function insertBlock(text, selection) {
    var value = editor.value;
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    var before = value.slice(0, start);
    var after = value.slice(end);
    var lead = '';
    if (start > 0 && !/\n\s*\n$/.test(before)) {
      lead = /\n$/.test(before) ? '\n' : '\n\n';
    }
    var trail = '';
    if (after === '') {
      trail = '\n';
    } else if (!/^\n/.test(after)) {
      trail = '\n\n';
    }
    var pointer = (selection && text.indexOf(selection) >= 0)
      ? start + lead.length + text.indexOf(selection)
      : start + lead.length + text.length + trail.length;
    var until = (selection && text.indexOf(selection) >= 0) ? pointer + selection.length : pointer;
    replaceEditorRange(start, end, lead + text + trail, pointer, until);
  }

  function formatTable() {
    var text = '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |';
    insertBlock(text, 'Column 1');
  }

  function formatRule() {
    insertBlock('---', null);
  }

  function formatMathBlock() {
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    var selected = editor.value.slice(start, end);
    if (/^\$\$[\s\S]*\$\$$/.test(selected)) {
      var inner = selected.slice(2, selected.length - 2).replace(/^\n|\n$/g, '');
      replaceEditorRange(start, end, inner, start, start + inner.length);
      return;
    }
    var body = selected || 'x = 1';
    var caret = start + 3;
    replaceEditorRange(start, end, '$$\n' + body + '\n$$', caret, caret + body.length);
  }

  function formatMermaid() {
    var text = '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```';
    insertBlock(text, 'graph TD');
  }

  function formatLink() {
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    var selected = editor.value.slice(start, end);
    var existing = /^\[([\s\S]*)\]\(([^)]*)\)$/.exec(selected);
    if (existing) {
      replaceEditorRange(start, end, existing[1], start, start + existing[1].length);
      return;
    }
    var body = selected || 'link text';
    var from = start + 1 + body.length + 2;
    replaceEditorRange(start, end, '[' + body + '](url)', from, from + 3);
  }

  // An address that could name a picture: no spaces, and either a path or a
  // URL rather than words.  Selected text that looks like one becomes the
  // source instead of the alt text.
  function looksLikeImageAddress(text) {
    if (!text || /\s/.test(text)) {
      return false;
    }
    if (/^(?:[A-Za-z]:[\\/]|\\\\|https?:\/\/|\.{0,2}[\\/])/.test(text)) {
      return true;
    }
    return /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(text);
  }

  // Quotes and angle brackets would end the attribute they sit in.
  function escapeAttribute(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // A picture is inserted as its own centred block with a width, because that
  // is what a README wants and what a bare `![alt](path)` cannot say: Markdown
  // has no syntax for a width or an alignment.  An existing `![alt](path)` is
  // turned into that block rather than thrown away, and the address is left
  // selected so it can be typed over or pasted in.
  function formatImage() {
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    var selected = editor.value.slice(start, end).trim();
    var alt = 'alt text';
    var source = 'path';
    var markdown = /^!\[([\s\S]*?)\]\(\s*([^)\s]*)\s*\)$/.exec(selected);
    if (markdown) {
      alt = markdown[1];
      source = markdown[2] || 'path';
    } else if (selected) {
      if (looksLikeImageAddress(selected)) {
        source = selected;
      } else {
        alt = selected;
      }
    }
    var text = '<p align="center">\n' +
               '  <img src="' + escapeAttribute(source) + '" alt="' + escapeAttribute(alt) +
               '" width="500">\n' +
               '</p>';
    insertBlock(text, source === 'path' ? 'path' : source);
  }

  // A footnote reference and its definition, added in one edit so the whole
  // pair comes back with a single undo.  Selected text becomes the footnote.
  function formatFootnote() {
    var value = editor.value;
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    var selected = value.slice(start, end);
    var used = {};
    var pattern = /\[\^([^\]\s]+)\]/g;
    var match;
    while ((match = pattern.exec(value)) !== null) {
      used[match[1]] = true;
    }
    var number = 1;
    while (used[String(number)]) {
      ++number;
    }
    var id = String(number);
    var body = value.slice(0, start) + '[^' + id + ']' + value.slice(end);
    var separator = (body === '' || /\n$/.test(body)) ? '\n' : '\n\n';
    var text = body + separator + '[^' + id + ']: ' + selected;
    replaceEditorRange(0, value.length, text, text.length);
  }

  // The callouts the renderer draws: a block quote whose first line is the
  // marker.  The marker is left as NOTE, and the four others are named in the
  // button's tooltip, since a README usually wants only one of them.
  function formatCallout() {
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    var selected = editor.value.slice(start, end).trim();
    var body = selected || 'Write the note here.';
    insertBlock('> [!NOTE]\n> ' + body, selected ? null : body);
  }

  function applyFormat(action) {
    switch (action) {
      case 'bold': formatWrap('**', '**'); break;
      case 'italic': formatWrap('*', '*'); break;
      case 'strike': formatWrap('~~', '~~'); break;
      case 'code': formatWrap('`', '`'); break;
      case 'superscript': formatWrap('<sup>', '</sup>'); break;
      case 'subscript': formatWrap('<sub>', '</sub>'); break;
      case 'heading1': formatHeading(1); break;
      case 'heading2': formatHeading(2); break;
      case 'heading3': formatHeading(3); break;
      case 'quote': formatQuote(); break;
      case 'callout': formatCallout(); break;
      case 'bullet': formatList('bullet'); break;
      case 'number': formatList('number'); break;
      case 'task': formatList('task'); break;
      case 'codeblock': formatCodeBlock(); break;
      case 'table': formatTable(); break;
      case 'rule': formatRule(); break;
      case 'footnote': formatFootnote(); break;
      case 'link': formatLink(); break;
      case 'image': formatImage(); break;
      case 'math': formatWrap('$', '$', 'x'); break;
      case 'mathblock': formatMathBlock(); break;
      case 'mermaid': formatMermaid(); break;
    }
  }

  function initFormatBar() {
    if (!formatBar) {
      return;
    }
    // Taking focus would collapse the editor's selection before the click ever
    // got here, so the button that was pressed does not steal it.
    formatBar.addEventListener('mousedown', function (event) {
      if (event.target.closest && event.target.closest('.format-button')) {
        event.preventDefault();
      }
    });
    formatBar.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('.format-button') : null;
      if (!button || button.disabled) {
        return;
      }
      var action = button.getAttribute('data-format');
      if (action) {
        applyFormat(action);
      }
    });
  }

  function saveActive() {
    syncEditorIntoTab();
    postToHost({ type: 'save', content: editor.value });
  }

  function saveActiveAs() {
    syncEditorIntoTab();
    postToHost({ type: 'saveAs', content: editor.value });
  }

  function saveActiveAsOrSave(asAnother) {
    if (asAnother) {
      saveActiveAs();
    } else {
      saveActive();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Find and replace                                                       */
  /* ---------------------------------------------------------------------- */

  function findPattern() {
    find.invalid = false;
    if (!find.query) {
      return null;
    }
    var source = find.query;
    if (!find.regex) {
      source = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    if (find.wholeWord) {
      // Lookarounds rather than \b, so that patterns which start or end with a
      // non-word character still match.
      source = '(?<![\\w$])(?:' + source + ')(?![\\w$])';
    }
    var flags = 'gm' + (find.caseSensitive ? '' : 'i');
    try {
      return new RegExp(source, flags);
    } catch (error) {
      find.invalid = true;
      return null;
    }
  }

  function refreshFindMatches(keepCurrent) {
    var previousStart = -1;
    if (keepCurrent && find.current >= 0 && find.matches[find.current]) {
      previousStart = find.matches[find.current].start;
    }
    find.matches = [];
    find.current = -1;
    if (find.open && find.query) {
      var pattern = findPattern();
      if (pattern) {
        var text = editor.value;
        var match;
        while ((match = pattern.exec(text)) !== null) {
          if (match[0].length === 0) {
            pattern.lastIndex += 1;   // never let a zero-width match stall the scan
            continue;
          }
          find.matches.push({
            start: match.index,
            end: match.index + match[0].length,
            text: match[0],
            groups: match
          });
          if (find.matches.length >= MAX_FIND_MATCHES) {
            break;
          }
        }
      }
    }
    if (previousStart >= 0) {
      for (var index = 0; index < find.matches.length; index++) {
        if (find.matches[index].start === previousStart) {
          find.current = index;
          break;
        }
      }
    }
    if (find.current < 0 && find.matches.length) {
      // Point at the first match so the counter reads "1 of n" and one of the
      // highlights is the current one, without moving the caret.
      find.current = 0;
    }
    renderFindHighlights();
    paintPreviewFindHits();
    updateFindCount();
  }

  function renderFindHighlights() {
    if (!find.open || !find.matches.length) {
      findHighlightInner.textContent = '';
      return;
    }
    var text = editor.value;
    var html = '';
    var position = 0;
    for (var index = 0; index < find.matches.length; index++) {
      var match = find.matches[index];
      if (match.start < position) {
        continue;  // overlapping matches cannot be painted twice
      }
      html += escapeHtml(text.slice(position, match.start));
      html += '<mark class="find-hit' + (index === find.current ? ' is-current' : '') + '">' +
              escapeHtml(text.slice(match.start, match.end)) + '</mark>';
      position = match.end;
    }
    html += escapeHtml(text.slice(position));
    findHighlightInner.innerHTML = html + '\n';
    syncFindHighlight();
  }

  // The highlight layer is a twin of the textarea: identical font metrics, same
  // padding, and pinned to the editor's scroll position.  Its width is copied
  // from clientWidth so that the wrap points match even while the textarea
  // shows a scrollbar.
  function syncFindHighlight() {
    if (!find.open) {
      return;
    }
    findHighlightInner.style.width = editor.clientWidth + 'px';
    findHighlightInner.style.transform =
      'translate(' + (-editor.scrollLeft).toFixed(1) + 'px,' + (-editor.scrollTop).toFixed(1) + 'px)';
  }

  function updateFindCount() {
    findInput.classList.toggle('is-invalid', find.invalid);
    if (find.invalid) {
      findCount.textContent = 'bad pattern';
      return;
    }
    if (!find.query) {
      findCount.textContent = '0/0';
      return;
    }
    findCount.textContent = (find.current >= 0 ? find.current + 1 : 0) + '/' + find.matches.length;
  }

  function lineFromOffset(offset) {
    var text = editor.value;
    var limit = Math.min(offset, text.length);
    var line = 0;
    for (var index = 0; index < limit; index++) {
      if (text.charCodeAt(index) === 10) {
        ++line;
      }
    }
    return line;
  }

  /* --- the preview's own highlights --------------------------------------- */

  // Nodes whose text is not prose.  Marking them would either be undone by the
  // renderer that owns the subtree (Mermaid, KaTeX) or change what is drawn
  // (an SVG or MathML tree has no plain text run to wrap).
  function skipPreviewFindNode(parent) {
    for (var node = parent; node && node !== markdown; node = node.parentNode) {
      var name = node.nodeName;
      if (name === 'svg' || name === 'SVG' || name === 'MATH' || name === 'SCRIPT' ||
          name === 'STYLE' || name === 'TEXTAREA') {
        return true;
      }
      if (node.classList && (node.classList.contains('katex') ||
                             node.classList.contains('mermaid') ||
                             node.classList.contains('mermaid-block'))) {
        return true;
      }
    }
    return false;
  }

  function clearPreviewFindHits() {
    for (var index = 0; index < previewFindHits.length; index++) {
      var mark = previewFindHits[index];
      var parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
      }
    }
    previewFindHits.length = 0;
    previewFindCurrent = -1;
    if (markdown.normalize) {
      // Merge the text nodes the marks were cut out of, so repeated repaints
      // do not leave a long document fragmented into tiny nodes.
      markdown.normalize();
    }
  }

  function paintPreviewTextNode(node, pattern) {
    var text = node.nodeValue;
    pattern.lastIndex = 0;
    var ranges = [];
    var match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;  // a zero-width match would never advance
        continue;
      }
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
    if (!ranges.length) {
      return;
    }

    var fragment = document.createDocumentFragment();
    var position = 0;
    for (var index = 0; index < ranges.length; index++) {
      var range = ranges[index];
      if (range.start > position) {
        fragment.appendChild(document.createTextNode(text.slice(position, range.start)));
      }
      var mark = document.createElement('mark');
      mark.className = 'find-hit';
      mark.textContent = text.slice(range.start, range.end);
      fragment.appendChild(mark);
      previewFindHits.push(mark);
      position = range.end;
    }
    if (position < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(position)));
    }
    node.parentNode.replaceChild(fragment, node);
  }

  // Paints the query into the rendered preview with the same pattern the source
  // scan uses, so case, whole word and regular expression behave identically in
  // both panes.  The nodes are collected before anything is replaced: mutating
  // while walking would confuse the walker.  The scrollbar's marks are redrawn
  // from whatever the marks ended up being, so the two cannot drift apart.
  function paintPreviewFindHits() {
    paintPreviewFindHitMarks();
    updateFindTicks();
  }

  function paintPreviewFindHitMarks() {
    clearPreviewFindHits();
    if (!find.open || !find.query || find.invalid || !find.matches.length) {
      return;
    }
    if (state.settings.viewMode === 'editor' || state.heavy) {
      // Not on screen, or too large to walk on every keystroke: the counter and
      // the scrolling still work, only the preview marks are skipped.
      return;
    }
    var pattern = findPattern();
    if (!pattern) {
      return;
    }

    var nodes = [];
    var walker = document.createTreeWalker(markdown, NodeFilter.SHOW_TEXT, null);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue || !node.nodeValue.length || skipPreviewFindNode(node.parentNode)) {
        continue;
      }
      nodes.push(node);
    }
    for (var index = 0; index < nodes.length; index++) {
      paintPreviewTextNode(nodes[index], pattern);
    }

    // When both panes agree on how many occurrences there are, the current
    // match is the same occurrence in the preview and can be singled out.
    if (find.current >= 0 && previewFindHits.length === find.matches.length) {
      previewFindHits[find.current].classList.add('is-current');
      previewFindCurrent = find.current;
    }
  }

  // Past this many marks the bars would touch and read as one solid line, and
  // measuring each of them starts to cost more than the bar is worth.  Every
  // nth match is kept instead, and the last one, so the bar still ends where
  // the document does.
  var MAX_FIND_TICKS = 300;

  // Draws one bar per match along the preview's scrollbar, at the height that
  // match has in the document, the way a browser marks where its finds are.
  // The bars come from the marks the preview actually painted, so the bar never
  // points at a match the page does not show; they take clicks only when the
  // two lists agree on the order, which is also when one of them is the current
  // match.
  function updateFindTicks() {
    findScroller.textContent = '';
    findScroller.hidden = true;
    if (!find.open || !previewFindHits.length || state.settings.viewMode === 'editor') {
      return;
    }
    var track = previewViewport.clientHeight;
    var total = previewViewport.scrollHeight;
    if (!track || !total) {
      return;
    }

    var step = Math.ceil(previewFindHits.length / MAX_FIND_TICKS);
    var places = [];
    for (var index = 0; index < previewFindHits.length; index += step) {
      places.push(index);
    }
    var last = previewFindHits.length - 1;
    if (places[places.length - 1] !== last) {
      places.push(last);
    }

    // Every position is read before a single node is written, so the document
    // is laid out once rather than once per mark.
    var origin = previewViewport.getBoundingClientRect().top - previewViewport.scrollTop;
    var offsets = [];
    for (index = 0; index < places.length; index++) {
      offsets.push(previewFindHits[places[index]].getBoundingClientRect().top - origin);
    }

    var clickable = previewFindHits.length === find.matches.length;
    var fragment = document.createDocumentFragment();
    for (index = 0; index < places.length; index++) {
      var tick = document.createElement('div');
      var isCurrent = clickable && places[index] === previewFindCurrent;
      tick.className = 'find-tick' + (isCurrent ? ' is-current' : '');
      tick.style.top = clamp(offsets[index] / total * track, 0, track - 3).toFixed(1) + 'px';
      if (clickable) {
        tick.dataset.match = String(places[index]);
        tick.title = 'Match ' + (places[index] + 1) + ' of ' + find.matches.length;
      }
      fragment.appendChild(tick);
    }

    // The layer starts where the viewport does, so its top edge is the top of
    // the scrollbar's track and its height is the track's own height: a
    // horizontal scrollbar shortens both, and the bars stay inside.
    findScroller.style.top = (previewViewport.getBoundingClientRect().top -
                              previewPane.getBoundingClientRect().top) + 'px';
    findScroller.style.height = track + 'px';
    findScroller.appendChild(fragment);
    findScroller.hidden = false;
  }

  // Rebuilding the bars measures every mark, and a window resize drags out one
  // layout per frame.  A burst of changes is collapsed into a single redraw on
  // the next frame rather than one redraw per change.
  var findTickFrame = 0;
  function scheduleFindTicks() {
    if (findTickFrame) {
      return;
    }
    findTickFrame = requestAnimationFrame(function () {
      findTickFrame = 0;
      updateFindTicks();
    });
  }

  // Brings the preview to the current match.  The painted marks line up with the
  // source matches in the normal case; when they do not (a match split across
  // inline markup), the block the match starts on is scrolled to instead.
  function scrollPreviewToFindHit(match) {
    ensureAnchors();
    var limit = maxScroll(previewViewport);
    var top = null;
    if (previewFindCurrent >= 0 && previewFindHits[previewFindCurrent]) {
      var mark = previewFindHits[previewFindCurrent];
      var position = mark.getBoundingClientRect().top -
                     previewViewport.getBoundingClientRect().top + previewViewport.scrollTop;
      top = position - previewViewport.clientHeight / 2 + mark.offsetHeight / 2;
    } else {
      var anchor = previewTopForLine(lineFromOffset(match.start));
      if (anchor !== null) {
        top = anchor - 24;
      }
    }
    if (top === null) {
      return;
    }
    programmatic.preview = Math.round(clamp(top, 0, limit));
    previewViewport.scrollTop = programmatic.preview;
    programmatic.preview = previewViewport.scrollTop;
  }

  /* --- the editor's selection in the preview ------------------------------ */

  // A selection made in the editor is painted where the same words sit in the
  // rendered document, so a phrase can be found in the preview without leaving
  // the source.  The rendered text is not the source text - markers, link
  // targets and tags are gone, and a paragraph's line breaks are spaces - so
  // both sides are reduced to their words and matched word for word.
  //
  // The same words can occur many times, and the selection knows the source
  // line it starts on: the candidate nearest that line wins, which is what
  // keeps a common word from being marked at the top of the document.

  var SELECTION_MATCH_CHARS = 1200;   // a longer selection is not a locator
  var SELECTION_MATCH_WORDS = 150;
  var SELECTION_MATCH_RUNS = 400;     // candidates looked at before giving up
  var SELECTION_EDGE_PUNCTUATION =
    '.,;:!?\'"`\u201c\u201d\u2018\u2019\u00ab\u00bb()[]{}<>*_~#|\\/-+=&@$%^\u2026\u2014\u2013';

  var previewSelectionHits = [];
  var previewSelectionTimer = 0;
  var previewDragging = false;   // a drag out of the preview is not a selection

  function isSelectionPunctuation(character) {
    return SELECTION_EDGE_PUNCTUATION.indexOf(character) !== -1;
  }

  // A character a word can be made of, used to tell whether a selection begins
  // or ends in the middle of one.
  function isSelectionWordCharacter(character) {
    return Boolean(character) && !/\s/.test(character) && !isSelectionPunctuation(character);
  }

  // Cuts a run of non-space text down to the word inside it: "**bold**" and
  // "(aside)" both lose what surrounds the word, while "snake_case" keeps the
  // underscore it carries in the middle.  The offsets come back too, because the
  // reverse direction has to turn a matched word into a place in the file.
  function wordWithin(piece) {
    var from = 0;
    var to = piece.length;
    while (from < to && isSelectionPunctuation(piece.charAt(from))) {
      ++from;
    }
    while (to > from && isSelectionPunctuation(piece.charAt(to - 1))) {
      --to;
    }
    return to > from ? { from: from, to: to, text: piece.slice(from, to) } : null;
  }

  function trimSelectionWord(piece) {
    var word = wordWithin(piece);
    return word ? word.text : '';
  }

  // The whole word an offset sits in or next to, so a selection that begins in
  // the middle of one can still be counted as that word and not its tail.
  function wordAround(text, offset) {
    var from = offset;
    var to = offset;
    while (from > 0 && !/\s/.test(text.charAt(from - 1))) {
      --from;
    }
    while (to < text.length && !/\s/.test(text.charAt(to))) {
      ++to;
    }
    return trimSelectionWord(text.slice(from, to));
  }

  // The words a selection covers, taken from the file's own word model so that
  // markup never becomes text: a selection that includes a link's brackets, an
  // image, or a tag in a code span reads the same as the page.  A selection that
  // starts or stops inside a word keeps only the part it covers, and says so,
  // so the preview is marked from the same place rather than from the start of
  // the word holding it.
  function selectionQuery(source, start, end) {
    var words = sourceWordModel(source);
    var query = { words: [], openStart: false, openEnd: false, inside: null };
    for (var index = 0; index < words.length; ++index) {
      var word = words[index];
      if (word.end <= start || word.start >= end) {
        continue;
      }
      var part = '';
      for (var place = 0; place < word.text.length; ++place) {
        var at = word.places[place];
        if (at >= start && at < end) {
          part += word.text.charAt(place);
        }
      }
      if (!part) {
        continue;
      }
      if (!query.words.length) {
        if (word.start < start) {
          query.openStart = true;
        }
        query.inside = word.lower;  // the word the selection sits in, if inside
      }
      query.words.push(part);
      if (word.end > end) {
        query.openEnd = true;
      }
    }
    return query;
  }

  // The word model of a whole document, kept until the document changes: a drag
  // asks for it at every step, and reading the file again each time would be
  // work with the same answer.
  var sourceWordCache = { text: null, words: null };

  function sourceWordModel(source) {
    if (sourceWordCache.text !== source) {
      sourceWordCache = { text: source, words: sourceWords(blankBlockMarkup(source)) };
    }
    return sourceWordCache.words;
  }

  // Walks the text the preview actually shows, in reading order.  A node that
  // belongs to a drawn subtree - Mermaid, KaTeX, an SVG - is left out, since
  // there is no prose in it to mark.  `includeBlank` keeps the whitespace-only
  // nodes, which a painted range needs so the mark has no gaps in it.
  function walkPreviewText(visit, includeBlank) {
    var walker = document.createTreeWalker(markdown, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || (!includeBlank && !/\S/.test(node.nodeValue))) {
          return NodeFilter.FILTER_REJECT;
        }
        return skipPreviewFindNode(node.parentNode) ? NodeFilter.FILTER_REJECT
                                                    : NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      visit(node);
    }
  }

  // The element that renders a text node as one block of prose.  Words are
  // read per block: a highlighting span or a bold run inside a paragraph does
  // not start a new word, and the trailing space of one block is not the
  // leading space of the next.
  var PREVIEW_BLOCKS = /^(P|H1|H2|H3|H4|H5|H6|LI|TD|TH|PRE|BLOCKQUOTE|DIV|DT|DD|TABLE|THEAD|TBODY|TR|CAPTION|UL|OL|DL|FIGURE|FIGCAPTION|SECTION|ARTICLE|ASIDE|HEADER|FOOTER|MAIN|NAV|DETAILS|SUMMARY)$/;

  function previewBlockElement(node) {
    for (var element = node.parentNode; element && element !== markdown;
         element = element.parentNode) {
      if (PREVIEW_BLOCKS.test(element.nodeName)) {
        return element;
      }
    }
    return markdown;
  }

  // Each block's text in one string, with the table that turns an offset in it
  // back into the node it came from.  Without this a word cut in two by a
  // highlighting span - "tools\fetch-vendor.ps1" - would count as two words on
  // the page and one in the file, and every count after it would be off.
  function previewRuns() {
    var runs = [];
    var current = null;
    var prior = null;
    walkPreviewText(function (node) {
      var block = previewBlockElement(node);
      if (!current || current.block !== block) {
        current = { block: block, text: '', segments: [] };
        runs.push(current);
        prior = null;
      } else if (prior && !/[\s]$/.test(prior.nodeValue) && !/^[\s]/.test(node.nodeValue) &&
                 previewBrokenBetween(prior, node)) {
        // A break or a drawn picture between two halves of a line is where the
        // reader sees two words, even with no space written anywhere.
        current.text += ' ';
      }
      current.segments.push({ node: node, from: current.text.length,
                              length: node.nodeValue.length });
      current.text += node.nodeValue;
      prior = node;
    }, true);
    return runs;
  }

  // Whether something that draws nothing but ends a word - a line break, a
  // picture, a rule - sits between two text nodes of the same block.
  var PREVIEW_BREAKS = 'br,img,hr,input,video,audio,iframe,object,embed,canvas';
  function previewBrokenBetween(previous, node) {
    try {
      var range = document.createRange();
      range.setStartAfter(previous);
      range.setEndBefore(node);
      return range.cloneContents().querySelector(PREVIEW_BREAKS) !== null;
    } catch (error) {
      return false;
    }
  }

  // The node and offset an offset of the block's text sits at.
  function previewPlace(run, offset) {
    for (var index = 0; index < run.segments.length; ++index) {
      var segment = run.segments[index];
      if (offset < segment.from + segment.length) {
        return { node: segment.node, offset: offset - segment.from };
      }
    }
    var last = run.segments[run.segments.length - 1];
    return { node: last.node, offset: last.length };
  }

  // Every word of the rendered document with the places it starts and ends, so
  // a match can be wrapped where it really is.
  function previewWords() {
    var words = [];
    var runs = previewRuns();
    for (var index = 0; index < runs.length; ++index) {
      var run = runs[index];
      var pattern = /[^\s]+/g;
      var piece;
      while ((piece = pattern.exec(run.text)) !== null) {
        var word = wordWithin(piece[0]);
        if (!word) {
          continue;
        }
        var start = previewPlace(run, piece.index + word.from);
        var end = previewPlace(run, piece.index + word.to);
        words.push({
          text: word.text,
          lower: word.text.toLowerCase(),
          node: start.node,
          start: start.offset,
          endNode: end.node,
          endOffset: end.offset,
          length: word.text.length
        });
      }
    }
    return words;
  }

  // Where a query word sits inside a preview word, or -1.  A selection that
  // starts in the middle of a word has to match the end of the first preview
  // word, and one that ends in the middle has to match the beginning of the
  // last; every word in between is matched whole.
  function selectionWordOffset(word, query, first, last, openStart, openEnd, ignoreCase) {
    var text = ignoreCase ? word.lower : word.text;
    if (first && openStart && last && openEnd) {
      return text.indexOf(query);
    }
    if (first && openStart) {
      return text.slice(text.length - query.length) === query ? text.length - query.length : -1;
    }
    if (last && openEnd) {
      return text.slice(0, query.length) === query ? 0 : -1;
    }
    return text === query ? 0 : -1;
  }

  // Runs of preview words that spell the query.  Exact case is tried first, so
  // a name written with capitals is not moved to a lower-case lookalike.
  // `inside` is the whole word a selection that starts and stops inside one
  // sits in: without it "ettin" out of "settings.ini" would also match
  // "settings", and the first of those in the file would be picked.
  function selectionRuns(words, query, ignoreCase, openStart, openEnd, inside) {
    var runs = [];
    if (!query.length) {
      return runs;
    }
    var last = words.length - query.length;
    for (var index = 0; index <= last; ++index) {
      if (openStart && openEnd && inside && query.length === 1 &&
          words[index].lower !== inside) {
        continue;  // the whole word is known, so a lookalike fragment is not it
      }
      var from = -1;
      var to = -1;
      var matched = true;
      for (var offset = 0; offset < query.length; ++offset) {
        var first = offset === 0;
        var final = offset === query.length - 1;
        var position = selectionWordOffset(words[index + offset], query[offset],
                                           first, final, openStart, openEnd, ignoreCase);
        if (position < 0) {
          matched = false;
          break;
        }
        if (first) {
          from = position;
        }
        if (final) {
          to = position + query[offset].length;
        }
      }
      if (matched) {
        runs.push({ start: index, end: index + query.length, from: from, to: to });
        if (runs.length >= SELECTION_MATCH_RUNS) {
          break;
        }
      }
    }
    return runs;
  }

  // Where a word sits in the preview, measured the same way the anchor table
  // measures a block, so the two can be compared.
  function previewWordTop(word) {
    try {
      var range = document.createRange();
      range.setStart(word.node, word.start);
      range.setEnd(word.node, word.start);
      var rect = range.getBoundingClientRect();
      return rect.top - previewViewport.getBoundingClientRect().top + previewViewport.scrollTop;
    } catch (error) {
      return null;
    }
  }

  // The top level block that owns a source line, as the anchor table pairs
  // them.  A line above the first block takes the first one.
  function previewBlockForLine(line) {
    if (!anchors.length) {
      return null;
    }
    var low = 0;
    var high = anchors.length - 1;
    var index = 0;
    while (low <= high) {
      var middle = (low + high) >> 1;
      if (anchors[middle].line <= line) {
        index = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return markdown.children[index] || null;
  }

  // A run is not always identifiable from its position: without a block table
  // the only thing left is how many look-alikes came before it.  Counting the
  // same prefix on the other side and taking the run with the same count keeps
  // the two panes on the same occurrence.
  function ordinalRun(runs, wanted, words, prefix) {
    var best = runs[0];
    var nearest = Infinity;
    for (var index = 0; index < runs.length; ++index) {
      var distance = Math.abs(occurrencesBefore(words, runs[index].start, prefix) - wanted);
      if (distance < nearest) {
        nearest = distance;
        best = runs[index];
        if (!distance) {
          break;
        }
      }
    }
    return best;
  }

  function nearestSelectionRun(runs, words, line, source, offset, prefix) {
    if (runs.length < 2) {
      return runs[0];
    }
    ensureAnchors();
    // The block the selection starts in is the strongest hint there is: the
    // same word elsewhere in the document is not a candidate at all.
    var block = previewBlockForLine(line);
    if (block) {
      for (var index = 0; index < runs.length; ++index) {
        if (block.contains(words[runs[index].start].node)) {
          return runs[index];
        }
      }
    }
    var anchor = previewTopForLine(line);
    if (anchor === null) {
      // No block table either, so the source's own count decides.
      return ordinalRun(runs, sourceMatchesBefore(source, offset, prefix), words, prefix);
    }
    var best = runs[0];
    var distance = Infinity;
    for (var candidate = 0; candidate < runs.length; ++candidate) {
      var top = previewWordTop(words[runs[candidate].start]);
      if (top === null) {
        continue;
      }
      var here = Math.abs(top - anchor);
      if (here < distance) {
        distance = here;
        best = runs[candidate];
      }
    }
    return best;
  }

  // Wraps [from, to) of one text node.  Splitting leaves the node before the
  // range untouched, so a node already handled is never disturbed by a later
  // split in the same node.
  function wrapSelectionNode(node, from, to) {
    var text = node.nodeValue || '';
    from = clamp(from, 0, text.length);
    to = clamp(to, from, text.length);
    if (to <= from || !node.parentNode) {
      return;
    }
    var middle = node.splitText(from);
    if (to - from < middle.nodeValue.length) {
      middle.splitText(to - from);
    }
    var mark = document.createElement('mark');
    mark.className = 'selection-hit';
    middle.parentNode.replaceChild(mark, middle);
    mark.appendChild(middle);
    previewSelectionHits.push(mark);
  }

  // Paints a run of preview words.  The words of one phrase can be split over
  // several nodes by inline markup, and a word itself can be cut in two by a
  // highlighting span, so the nodes between the first and the last are taken
  // whole, with only the ends cut to the words themselves.
  function paintSelectionRun(words, run) {
    var first = words[run.start];
    var last = words[run.end - 1];
    var nodes = [];
    walkPreviewText(function (node) {
      nodes.push(node);
    }, true);
    var fromIndex = nodes.indexOf(first.node);
    var toIndex = nodes.indexOf(last.endNode);
    if (fromIndex < 0 || toIndex < 0) {
      return;
    }
    for (var index = fromIndex; index <= toIndex; ++index) {
      var text = nodes[index].nodeValue || '';
      var start = 0;
      var end = text.length;
      if (index === fromIndex) {
        start = Math.min(first.start + run.from, text.length);
      }
      if (index === toIndex) {
        // The tail of the last word may begin before the node it ends in.
        end = last.endOffset - (last.length - run.to);
        end = Math.max(start, Math.min(end, text.length));
      }
      wrapSelectionNode(nodes[index], start, end);
    }
  }

  function clearPreviewSelectionHits() {
    if (!previewSelectionHits.length) {
      return;
    }
    for (var index = 0; index < previewSelectionHits.length; ++index) {
      var mark = previewSelectionHits[index];
      var parent = mark.parentNode;
      if (!parent) {
        continue;
      }
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
    }
    previewSelectionHits.length = 0;
    if (markdown.normalize) {
      // Put the split text nodes back together, so a dragged selection does not
      // leave the document cut into fragments.
      markdown.normalize();
    }
  }

  function paintPreviewSelection() {
    clearPreviewSelectionHits();
    if (state.settings.viewMode === 'editor' || state.heavy || find.open) {
      return;
    }
    var source = editor.value;
    var start = editor.selectionStart || 0;
    var end = editor.selectionEnd || 0;
    if (end <= start || end - start > SELECTION_MATCH_CHARS) {
      return;
    }
    var picked = selectionQuery(source, start, end);
    var query = picked.words;
    if (!query.length || query.length > SELECTION_MATCH_WORDS) {
      return;
    }
    var openStart = picked.openStart;
    var openEnd = picked.openEnd;
    var words = previewWords();
    var runs = selectionRuns(words, query, false, openStart, openEnd,
                             picked.inside);
    if (!runs.length) {
      var lowered = [];
      for (var index = 0; index < query.length; ++index) {
        lowered.push(query[index].toLowerCase());
      }
      runs = selectionRuns(words, lowered, true, openStart, openEnd,
                           picked.inside);
    }
    if (!runs.length) {
      return;
    }
    var prefix = (wordAround(source, start) || query[0]).toLowerCase();
    paintSelectionRun(words, nearestSelectionRun(runs, words, lineFromOffset(start),
                                                source, start, prefix));
  }

  // The textarea reports every step of a drag as a selection change; painting
  // each one would rebuild the word table dozens of times a second.
  function schedulePreviewSelection() {
    if (previewSelectionTimer) {
      return;
    }
    previewSelectionTimer = setTimeout(function () {
      previewSelectionTimer = 0;
      paintPreviewSelection();
    }, 60);
  }

  /* --- the preview's selection in the editor ------------------------------- */

  // The other direction: a phrase picked out in the rendered document is
  // selected in the source, which is how the program is actually read - look at
  // the preview, spot something to change, select it, and be in the editor.
  //
  // Looking a rendered phrase up in the source has the same trouble in reverse:
  // the markup is not shown, and a paragraph's line breaks became spaces.  The
  // source lines the block was rendered from are blanked in place - each
  // construct replaced by spaces of its own length - so the words that survive
  // still sit at the offsets they have in the file, and the same word matching
  // as the other direction finds the run to select.

  // A blank run of the same length, so a construct can be taken out without
  // moving anything that follows it.
  function blankRun(length) {
    return length > 0 ? new Array(length + 1).join(' ') : '';
  }

  // Inline code is shown exactly as written, so a tag inside one is text and
  // not markup: `./<file>.deb` reads as "file>.deb" on the page.  The spans are
  // filled with a character no rule below touches, then put back.  A fence is
  // not an inline span, so the fence lines go first and only a single line of
  // one or two backticks counts here.
  var INLINE_CODE = /(`{1,2})([^`\n]*?)\1/g;

  // Tags that sit inside a line of prose.  The page joins the words on either
  // side of one - `<b>Fast</b>er` reads as "Faster" - while a block tag or a
  // break is where it starts a new word.
  var INLINE_TAGS = /^(a|abbr|b|bdi|bdo|cite|code|data|del|dfn|em|font|i|ins|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)$/i;

  // Where a fenced block starts and stops, by line, so its content can be kept
  // as written and its fence lines taken out.  An unclosed fence runs to the
  // end, which is what a renderer does with it.
  function fencedBlocks(text) {
    var blocks = [];
    var lines = text.split('\n');
    var offset = 0;
    var open = null;
    for (var index = 0; index < lines.length; ++index) {
      var line = lines[index];
      var match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (open) {
        if (match && match[1].charAt(0) === open.character &&
            match[1].length >= open.length) {
          blocks.push({ content: { from: open.from, to: offset },
                        fences: [{ from: open.lineStart, to: open.lineStart + open.lengthOfLine },
                                 { from: offset, to: offset + line.length }] });
          open = null;
        }
      } else if (match) {
        open = { character: match[1].charAt(0), length: match[1].length,
                 from: offset + line.length + 1, lineStart: offset,
                 lengthOfLine: line.length };
      }
      offset += line.length + 1;
    }
    if (open) {
      blocks.push({ content: { from: open.from, to: text.length },
                    fences: [{ from: open.lineStart, to: open.lineStart + open.lengthOfLine }] });
    }
    return blocks;
  }

  // A source slice as the page reads it: what is drawn but not written - an
  // image, a tag, a fence - is blanked away, and a link keeps its label exactly
  // where the label was.
  function blankBlockMarkup(text) {
    var spans = [];
    // A code block, like inline code, is shown exactly as written, so a tag in
    // it is text.  The fences go, the content stays.
    var blocks = fencedBlocks(text);
    var characters = text.split('');
    for (var block = 0; block < blocks.length; ++block) {
      var fences = blocks[block].fences;
      for (var fence = 0; fence < fences.length; ++fence) {
        for (var place = fences[fence].from; place < fences[fence].to; ++place) {
          characters[place] = ' ';
        }
      }
      var content = blocks[block].content;
      spans.push({ at: content.from, ticks: 0,
                   text: text.slice(content.from, content.to) });
      for (var spot = content.from; spot < content.to; ++spot) {
        characters[spot] = '\uE000';
      }
    }
    var guarded = characters.join('')
      .replace(INLINE_CODE, function (whole, ticks, inner, offset) {
        spans.push({ at: offset + ticks.length, ticks: ticks.length, text: inner });
        return blankRun(whole.length).replace(/ /g, '\uE000');
      });
    var blanked = guarded
      .replace(/<!--[\s\S]*?-->/g, function (whole) {
        return blankRun(whole.length);  // a comment is not shown at all
      })
      .replace(/<((?:https?|mailto|ftp):[^>\s]*)>/gi, function (whole, url) {
        return ' ' + url + ' ';  // an autolink shows the address itself
      })
      .replace(/!\[[^\]]*\]\([^)]*\)/g, function (whole) {
        return blankRun(whole.length);
      })
      .replace(/\[([^\]]*)\]\([^)]*\)/g, function (whole, label) {
        return blankRun(1) + label + blankRun(whole.length - label.length - 1);
      })
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, function (whole, label) {
        return blankRun(1) + label + blankRun(whole.length - label.length - 1);
      })
      .replace(/<\/?([A-Za-z][A-Za-z0-9-]*)[^>]*>/g, function (whole, name) {
        if (INLINE_TAGS.test(name)) {
          // Taken out without a gap: the words it sat between are one word.
          return blankRun(whole.length).replace(/ /g, '\uE000');
        }
        return blankRun(whole.length);  // a real tag, not "p < 0.001"
      })
      .replace(/^[ \t]{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])[ \t]+/gm, function (whole) {
        return blankRun(whole.length);
      });
    if (!spans.length) {
      return blanked;
    }
    var characters = blanked.split('');
    for (var index = 0; index < spans.length; ++index) {
      var span = spans[index];
      // The whole span goes back to spaces - the backticks were never shown -
      // and the code itself goes back exactly where it was.  The ticks stay
      // marked rather than blanked, so `Ctrl`+`wheel` does not become two words
      // on one side and one on the other; sourceWords drops the marks.
      var from = span.at - span.ticks;
      var to = from + span.ticks + span.text.length + span.ticks;
      for (var place = from; place < to; ++place) {
        characters[place] = ' ';
      }
      for (var offset = 0; offset < span.text.length; ++offset) {
        characters[span.at + offset] = span.text.charAt(offset);
      }
      for (var mark = 0; mark < span.ticks; ++mark) {
        characters[from + mark] = '\uE000';
        characters[span.at + span.text.length + mark] = '\uE000';
      }
    }
    return characters.join('');
  }

  // Every word of a blanked slice, with the offsets that put it back.  The one
  // backslash the page does not show is the one that carries a pipe through a
  // table cell: `a\|b` in a row reads as "a|b".  Anywhere else an escape is
  // literal, code spans especially, so it is left alone.
  function sourceWords(text) {
    var words = [];
    var pattern = /[^\s]+/g;
    var piece;
    var lineStart = 0;
    var lineEnd = text.indexOf('\n');
    if (lineEnd < 0) {
      lineEnd = text.length;
    }
    while ((piece = pattern.exec(text)) !== null) {
      // The marks stand where a delimiter was taken out: they keep the offsets
      // true without breaking the word they sat in.
      var raw = piece[0];
      var places = [];
      var clean = '';
      for (var index = 0; index < raw.length; ++index) {
        if (raw.charAt(index) === '\uE000') {
          continue;
        }
        clean += raw.charAt(index);
        places.push(piece.index + index);
      }
      var word = wordWithin(clean);
      if (!word) {
        continue;
      }
      while (piece.index > lineEnd) {
        lineStart = lineEnd + 1;
        lineEnd = text.indexOf('\n', lineStart);
        if (lineEnd < 0) {
          lineEnd = text.length;
        }
      }
      // A pipe carried through a table cell loses its backslash, so the shown
      // text is built character by character with the place each one came from.
      var isRow = /^[ \t]*\|/.test(text.slice(lineStart, lineEnd));
      var shown = '';
      var spots = [];
      for (var offset = word.from; offset < word.to; ++offset) {
        var character = clean.charAt(offset);
        if (isRow && character === '\\' && clean.charAt(offset + 1) === '|' &&
            offset + 1 < word.to) {
          shown += '|';
          spots.push(places[offset]);
          ++offset;
          continue;
        }
        shown += character;
        spots.push(places[offset]);
      }
      // A delimiter taken out of the source has to come back with the word it
      // wrapped, or the selection would have a stray tick in the middle of it:
      // "Ctrl+wheel" is written `Ctrl`+wheel and "settings.ini" is written
      // `settings.ini`.  The exact extent stays as it is, since it is what says
      // whether a selection in the editor was cut inside the word; the wider
      // one is what the preview's selection turns into.
      var start = places[word.from];
      var end = places[word.to - 1] + 1;
      var wrapStart = start;
      var wrapEnd = end;
      while (wrapStart > piece.index && text.charAt(wrapStart - 1) === '\uE000') {
        --wrapStart;
      }
      while (wrapEnd < piece.index + raw.length && text.charAt(wrapEnd) === '\uE000') {
        ++wrapEnd;
      }
      words.push({
        text: shown,
        lower: shown.toLowerCase(),
        start: start,
        end: end,
        wrapStart: wrapStart,
        wrapEnd: wrapEnd,
        places: spots
      });
    }
    return words;
  }

  // The words a rendered selection is made of.  Nothing in it is markup, so the
  // only question is where each word begins and ends.
  function selectedWords(text) {
    var pieces = String(text || '').split(/\s+/);
    var words = [];
    for (var index = 0; index < pieces.length; ++index) {
      var word = wordWithin(pieces[index]);
      if (word) {
        words.push(word.text);
      }
    }
    return words;
  }

  // The offset every line starts at, so a line number can be turned back into a
  // place in the file.
  function lineStarts(text) {
    var starts = [0];
    for (var index = 0; index < text.length; ++index) {
      if (text.charCodeAt(index) === 10) {
        starts.push(index + 1);
      }
    }
    return starts;
  }

  // The top level block a node belongs to - the unit the anchor table pairs
  // with a source line.
  function previewBlockOf(node) {
    var element = node && node.nodeType === 1 ? node : (node ? node.parentNode : null);
    while (element && element.parentNode !== markdown) {
      element = element.parentNode;
    }
    return element && element.parentNode === markdown ? element : null;
  }

  // The source lines those blocks came from.  Without a usable anchor table the
  // whole file is searched, and `exact` says so: the caller then has to tell one
  // occurrence from another by counting, since the block cannot say where it is.
  function linesForPreviewBlocks(first, last) {
    ensureAnchors();
    var children = markdown.children;
    var startIndex = -1;
    var endIndex = -1;
    for (var index = 0; index < children.length; ++index) {
      if (children[index] === first) {
        startIndex = index;
      }
      if (children[index] === last) {
        endIndex = index;
      }
    }
    var total = lineStarts(editor.value).length - 1;
    if (startIndex < 0 || endIndex < 0 || !anchors.length) {
      return { from: 0, to: total, exact: false };
    }
    var from = startIndex < anchors.length ? anchors[startIndex].line : 0;
    var to = endIndex + 1 < anchors.length ? anchors[endIndex + 1].line - 1 : total;
    return { from: from, to: Math.max(from, to), exact: true };
  }

  // How many words before `limit` begin like `prefix`, counted the same way in
  // both panes.  The page and the file hold the same words in the same order,
  // so the third "of" on the page is the third "of" in the source - which is
  // what tells two look-alikes apart when the block table cannot.
  function occurrencesBefore(words, limit, prefix) {
    var count = 0;
    for (var index = 0; index < limit && index < words.length; ++index) {
      if (words[index].lower.lastIndexOf(prefix, 0) === 0) {
        ++count;
      }
    }
    return count;
  }

  // The same count on the source side: the words before `offset` that begin
  // like `prefix`.  The markup is blanked in place first, so a link's target
  // does not count as a word the page shows.
  function sourceMatchesBefore(source, offset, prefix) {
    var words = sourceWordModel(source);
    var count = 0;
    for (var index = 0; index < words.length; ++index) {
      if (words[index].end > offset) {
        break;
      }
      if (words[index].lower.lastIndexOf(prefix, 0) === 0) {
        ++count;
      }
    }
    return count;
  }

  // Where the selection starts on the page, and the word it starts in.  A drag
  // can begin in the middle of a word - "ownload" out of "Download" - and then
  // the query's first word is only a tail, which never tells two look-alikes
  // apart.  The whole word is the thing to count.
  function previewSelectionAnchor(range) {
    var spoken = previewWords();
    var container = range.startContainer;
    var offset = range.startOffset;
    // A drag that began in the middle of a word begins at a point the word
    // starts before, so the word containing it is the one to count - not the
    // next one, which is what comparing word starts finds.
    if (container && container.nodeType === 3) {
      for (var index = 0; index < spoken.length; ++index) {
        var word = spoken[index];
        var length = container.nodeValue ? container.nodeValue.length : 0;
        if (word.node === container && offset >= word.start &&
            offset < Math.min(length, word.start + word.text.length)) {
          return { words: spoken, index: index, word: word.lower };
        }
      }
    }
    for (var place = 0; place < spoken.length; ++place) {
      if (range.comparePoint(spoken[place].node, spoken[place].start) >= 0) {
        return { words: spoken, index: place, word: spoken[place].lower };
      }
    }
    return null;
  }

  // Selects the source the preview selection came from, and repaints the mark
  // from that selection so both panes say the same thing.
  function reflectPreviewSelection() {
    if (state.settings.viewMode === 'editor') {
      return;
    }
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount) {
      return;
    }
    var range = selection.getRangeAt(0);
    if (!markdown.contains(range.commonAncestorContainer)) {
      return;  // the selection is the editor's or the find box's, not ours
    }
    var text = selection.toString();
    if (!/\S/.test(text)) {
      // A click, not a selection.  The page has nothing picked in it any more,
      // so the mark from the last selection goes and the source it pointed at
      // is let go too - otherwise a click would leave the highlight sitting on
      // the page until another selection replaced it.
      clearPreviewSelectionHits();
      if (editor.selectionStart !== editor.selectionEnd) {
        editor.setSelectionRange(editor.selectionStart, editor.selectionStart);
      }
      return;
    }
    var first = previewBlockOf(range.startContainer);
    var last = previewBlockOf(range.endContainer) || first;
    if (!first) {
      return;
    }
    // A drag can start and stop inside words; the words holding those edges are
    // matched by their ends, as in the other direction.
    var openStart = range.startContainer.nodeType === 3 && range.startOffset > 0 &&
                    isSelectionWordCharacter(
                      range.startContainer.nodeValue.charAt(range.startOffset - 1));
    var openEnd = range.endContainer.nodeType === 3 && range.endOffset > 0 &&
                  isSelectionWordCharacter(
                    range.endContainer.nodeValue.charAt(range.endOffset - 1));

    // The mark is rebuilt from the editor selection below; the old one has to go
    // first, or a selection made here would leave the previous one painted.
    var query = selectedWords(text);
    if (text.length > SELECTION_MATCH_CHARS || !query.length ||
        query.length > SELECTION_MATCH_WORDS) {
      return;
    }

    var source = editor.value;
    var starts = lineStarts(source);
    var lines = linesForPreviewBlocks(first, last);
    // Without the block's own lines the same words exist elsewhere in the file,
    // so the count of look-alikes before the selection is what picks the right
    // one.  It is read here, while the selection still points into live nodes.
    // A selection inside a single word needs that whole word too, to keep the
    // fragment from matching a shorter word elsewhere.
    var anchor = lines.exact ? null : previewSelectionAnchor(range);
    var wanted = anchor ? occurrencesBefore(anchor.words, anchor.index, anchor.word) : 0;
    var prefix = anchor ? anchor.word : query[0].toLowerCase();

    clearPreviewSelectionHits();

    var from = lines.from < starts.length ? starts[lines.from] : source.length;
    var to = lines.to + 1 < starts.length ? starts[lines.to + 1] : source.length;
    var words = sourceWords(blankBlockMarkup(source.slice(from, to)));
    if (!words.length) {
      return;
    }
    var runs = selectionRuns(words, query, false, openStart, openEnd,
                             anchor ? anchor.word : null);
    if (!runs.length) {
      var lowered = [];
      for (var index = 0; index < query.length; ++index) {
        lowered.push(query[index].toLowerCase());
      }
      runs = selectionRuns(words, lowered, true, openStart, openEnd,
                           anchor ? anchor.word : null);
    }
    if (!runs.length) {
      return;  // nothing in the source spells this: leave the editor alone
    }

    // Inside the block's own lines the first run is the one the reader pointed
    // at, because the search never left the block.  Without them, the count of
    // look-alikes before the selection is what tells two of them apart.
    var run = lines.exact ? runs[0] : ordinalRun(runs, wanted, words, prefix);
    // The browser finishes the release after the handlers return, and that
    // includes putting the focus where the click landed: taking it here would be
    // undone a moment later, leaving the source selected but unpainted.  One
    // turn of the event loop is the first moment the editor can keep it.
    setTimeout(function () {
      // A word's shown text and its place in the file are not always the same
      // length - a code span's backticks were taken out, `\|` became one
      // character - so the ends are read from the places the word kept.
      var head = words[run.start];
      var tail = words[run.end - 1];
      var headAt = run.from === 0 ? head.wrapStart : head.places[run.from];
      var tailAt = run.to >= tail.text.length
                 ? tail.wrapEnd
                 : tail.places[run.to - 1] + 1;
      focusPreviewSelectionSource(from + headAt, from + tailAt);
    }, 0);
  }

  // Selects the source range in the editor, brings it into view without moving
  // the preview, and repaints the mark from the editor selection so both panes
  // say the same thing.
  function focusPreviewSelectionSource(start, end) {
    if (state.settings.viewMode !== 'preview') {
      try {
        editor.focus({ preventScroll: true });
      } catch (error) {
        editor.focus();
      }
    }
    editor.setSelectionRange(start, end);
    if (state.settings.viewMode !== 'preview') {
      // The line comes into view; the preview stays where it is, since that is
      // where the reader just made the selection.
      computeMetrics();
      var top = metrics.paddingTop +
                visualFromLogicalLine(lineFromOffset(start)) * metrics.lineHeight -
                editor.clientHeight / 2;
      programmatic.editor = Math.round(clamp(top, 0, maxScroll(editor)));
      editor.scrollTop = programmatic.editor;
      programmatic.editor = editor.scrollTop;
      renderGutter();
    }
    updateCursorStatus();
    if (state.settings.viewMode === 'split') {
      paintPreviewSelection();
    }
  }

  // Moves to a match.  focusEditor is false when the move comes from the
  // scrollbar: the find box keeps the focus, so the user can carry on typing.
  function goToMatch(index, focusEditor) {
    var count = find.matches.length;
    if (!count) {
      return;
    }
    find.current = ((index % count) + count) % count;
    var match = find.matches[find.current];
    // In preview-only mode the editor pane is hidden: moving its caret would
    // pull focus out of the find box (so typing would stop) and scrolling it
    // would move something the user cannot see.  The preview follows instead.
    if (state.settings.viewMode !== 'preview') {
      if (focusEditor !== false) {
        try {
          editor.focus({ preventScroll: true });
        } catch (error) {
          editor.focus();
        }
      }
      editor.setSelectionRange(match.start, match.end);
      computeMetrics();
      var top = metrics.paddingTop + visualFromLogicalLine(lineFromOffset(match.start)) * metrics.lineHeight -
                editor.clientHeight / 2;
      programmatic.editor = clamp(top, 0, maxScroll(editor));
      editor.scrollTop = programmatic.editor;
      syncFromEditor();
      renderGutter();
      updateCursorStatus();
    }
    renderFindHighlights();
    paintPreviewFindHits();
    if (state.settings.viewMode !== 'editor') {
      scrollPreviewToFindHit(match);
    }
    // The reader chose to move here, so this is the place a later zoom, view
    // switch or reload returns to.
    rememberPlace();
    updateFindCount();
  }

  function findNext(direction) {
    if (find.invalid) {
      return;
    }
    if (!find.matches.length) {
      refreshFindMatches(false);
    }
    if (!find.matches.length) {
      updateFindCount();
      return;
    }
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    if (state.settings.viewMode === 'preview' && find.current >= 0 &&
        find.current < find.matches.length) {
      // The hidden editor keeps whatever caret it had, so in preview-only mode
      // "next" continues from the match that is highlighted, not from there.
      start = find.matches[find.current].start;
      end = find.matches[find.current].end;
    }
    var target = -1;
    var index;
    if (direction >= 0) {
      for (index = 0; index < find.matches.length; index++) {
        if (find.matches[index].start >= end) {
          target = index;
          break;
        }
      }
      if (target === -1) {
        target = 0;
      }
    } else {
      for (index = find.matches.length - 1; index >= 0; index--) {
        if (find.matches[index].end <= start) {
          target = index;
          break;
        }
      }
      if (target === -1) {
        target = find.matches.length - 1;
      }
    }
    goToMatch(target);
  }

  function expansionFor(match) {
    var template = find.replacement;
    if (!find.regex) {
      return template;
    }
    return template.replace(/\$(\$|&|\d{1,2})/g, function (whole, group) {
      if (group === '$') {
        return '$';
      }
      if (group === '&') {
        return match.text;
      }
      var index = Number(group);
      if (index > 0 && index < match.groups.length) {
        return match.groups[index] === undefined ? '' : match.groups[index];
      }
      return whole;
    });
  }

  function replaceCurrent() {
    if (find.invalid) {
      return;
    }
    refreshFindMatches(true);
    if (!find.matches.length) {
      showToast('No matches to replace', true);
      return;
    }
    if (find.current < 0) {
      findNext(1);
    }
    var match = find.matches[find.current];
    if (!match) {
      return;
    }
    var replacement = expansionFor(match);
    var text = editor.value;
    editor.value = text.slice(0, match.start) + replacement + text.slice(match.end);
    var caret = match.start + replacement.length;
    editor.setSelectionRange(caret, caret);
    markEdited();
    refreshFindMatches(false);
    findNext(1);
  }

  function replaceAllMatches() {
    if (find.invalid) {
      return;
    }
    refreshFindMatches(false);
    var count = find.matches.length;
    if (!count) {
      showToast('No matches to replace', true);
      return;
    }
    var text = editor.value;
    for (var index = count - 1; index >= 0; index--) {
      var match = find.matches[index];
      text = text.slice(0, match.start) + expansionFor(match) + text.slice(match.end);
    }
    editor.value = text;
    editor.setSelectionRange(0, 0);
    markEdited();
    refreshFindMatches(false);
    showToast(count + (count === 1 ? ' replacement' : ' replacements'), false);
  }

  function openFindBar(focusReplace) {
    // The pane the user is reading stays the pane they are reading: opening
    // Find must not switch preview-only back to split.
    // A selection made in the editor becomes the query, like every editor does.
    if (!find.open && document.activeElement === editor && editor.selectionEnd > editor.selectionStart) {
      var selection = editor.value.slice(editor.selectionStart, editor.selectionEnd);
      if (selection && selection.indexOf('\n') === -1) {
        find.query = selection;
        findInput.value = selection;
      }
    }
    find.open = true;
    findBar.hidden = false;
    // Find paints its own marks; a selection mark under them would only nest.
    clearPreviewSelectionHits();
    refreshFindMatches(true);
    syncFindHighlight();
    var target = focusReplace ? replaceInput : findInput;
    target.focus();
    target.select();
  }

  function closeFindBar() {
    find.open = false;
    findBar.hidden = true;
    find.matches = [];
    find.current = -1;
    findHighlightInner.textContent = '';
    clearPreviewFindHits();
    updateFindTicks();
    if (state.settings.viewMode !== 'preview' &&
        (document.activeElement === findInput || document.activeElement === replaceInput)) {
      editor.focus();
    }
    // The selection that opened the search is still in the editor, so it goes
    // back on the page now that the search marks are gone.
    paintPreviewSelection();
  }

  /* ---------------------------------------------------------------------- */
  /* Message channel with the native host                                   */
  /* ---------------------------------------------------------------------- */

  function handleHostMessage(data) {
    if (!data || typeof data !== 'object') {
      return;
    }
    switch (data.type) {
    case 'settings':
      applySettings(data);
      break;
    case 'tabs':
      reconcileTabs(data);
      break;
    case 'document':
    case 'load':
      applyHostDocument(data);
      break;
    case 'saved':
      applySaved(data);
      break;
    case 'closeTab':
      closeTabLocally(Number(data.index), Number(data.active));
      break;
    case 'collapse':
      collapseTabs(Number(data.keep));
      break;
    case 'requestContent':
      postAllContents(String(data.reason || ''));
      break;
    case 'defaultAppState':
      applyDefaultAppState(data);
      break;
    case 'insertText':
      insertTextAtCursor(String(data.text || ''));
      break;
    case 'zoom':
      state.zoom = Number(data.value) || 1;
      break;
    case 'toast':
      showToast(String(data.text || ''), Boolean(data.error));
      break;
    case 'linkMissing':
      showToast('No such file: ' + String(data.path || ''), true);
      break;
    case 'imageReady':
    case 'imageFailed':
      remoteImageAnswered(data);
      break;
    case 'cacheSize':
      imageCache = { files: Number(data.files) || 0, bytes: Number(data.bytes) || 0 };
      refreshOpenMenu();
      break;
    case 'update':
      updateState = data;
      refreshOpenMenu();
      if (data.asked) {
        // The user asked for this check, so it reports itself - including the
        // moment it starts.  The background check at start-up stays silent.
        var text = updateToastText(data);
        if (text) {
          showToast(text, data.state === 'failed');
        }
      }
      break;
    default:
      break;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Settings, theme and view mode                                          */
  /* ---------------------------------------------------------------------- */

  function postSetting(name, value) {
    postToHost({ type: 'setting', name: name, value: String(value) });
  }

  // The host owns the persisted settings; this applies what it reports.
  function applySettings(data) {
    var settings = state.settings;
    if (data.view === 'split' || data.view === 'editor' || data.view === 'preview') {
      if (data.view !== settings.viewMode) {
        // Read the place from the pane that is on screen before they swap.
        holdPlace();
        settings.viewMode = data.view;
      }
    }
    if (typeof data.dark === 'boolean') {
      settings.dark = data.dark;
    }
    if (typeof data.startBlank === 'boolean') {
      settings.startBlank = data.startBlank;
    }
    if (typeof data.wrap === 'boolean') {
      settings.wrap = data.wrap;
    }
    if (typeof data.defaultApp === 'boolean') {
      settings.defaultApp = data.defaultApp;
    }
    if (typeof data.version === 'string') {
      appVersion = data.version;
      if (!aboutDialog.hidden) {
        aboutSummary.textContent = aboutSummaryText();
      }
    }
    applyViewMode();
    applyWrap();
    applyTheme();
    refreshOpenMenu();
  }

  function setViewMode(mode, persist) {
    if (mode !== state.settings.viewMode) {
      // Read the place from the pane that is on screen before they swap.
      holdPlace();
    }
    state.settings.viewMode = mode;
    applyViewMode();
    if (persist) {
      postSetting('viewMode', mode);
    }
  }

  function applyViewMode() {
    var mode = state.settings.viewMode;
    workspace.classList.toggle('view-editor', mode === 'editor');
    workspace.classList.toggle('view-preview', mode === 'preview');
    afterResize();
    if (find.open && mode !== 'editor') {
      // Marks are skipped while the preview is hidden, so paint them on the way in.
      paintPreviewFindHits();
    }
    paintPreviewSelection();
  }

  function applyWrap() {
    state.wrapLines = state.settings.wrap !== false;
    editor.classList.toggle('no-wrap', !state.wrapLines);
    editor.setAttribute('wrap', state.wrapLines ? 'soft' : 'off');
    findHighlightInner.classList.toggle('no-wrap', !state.wrapLines);
    metrics.text = null;
    renderGutter();
  }

  function setWrapLines(value, persist) {
    var next = Boolean(value);
    var changed = (state.settings.wrap !== next);
    state.settings.wrap = next;
    applyWrap();
    afterResize();
    if (persist && changed) {
      postSetting('wrap', next ? 1 : 0);
    }
    if (changed) {
      showToast(next ? 'Line wrapping on' : 'Line wrapping off', false);
    }
  }

  function setDarkMode(dark, persist) {
    state.settings.dark = Boolean(dark);
    applyTheme();
    if (persist) {
      postSetting('darkMode', state.settings.dark ? 1 : 0);
    }
  }

  function applyTheme() {
    var dark = state.settings.dark !== false;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    if (prismDarkLink) {
      prismDarkLink.disabled = !dark;
    }
    if (prismLightLink) {
      prismLightLink.disabled = dark;
    }
    // Diagrams carry the palette they were drawn with, so they are redrawn.
    initMermaid(dark);
    mermaidCache.clear();
    renderNow();
  }

  function setStartBlank(value) {
    state.settings.startBlank = Boolean(value);
    postSetting('startBlank', state.settings.startBlank ? 1 : 0);
    showToast(state.settings.startBlank
      ? 'Starting with a blank document'
      : 'Starting with the welcome document', false);
  }

  function setDefaultApp(value) {
    postToHost({ type: 'setDefaultApp', value: Boolean(value) });
  }

  function applyDefaultAppState(data) {
    state.settings.defaultApp = Boolean(data.value);
    if (data.notice) {
      // A notice, not a failure: the registration worked, Windows simply has
      // its own idea about which application opens the file.
      showToast(String(data.notice), false);
    }
    refreshOpenMenu();
  }

  /* ---------------------------------------------------------------------- */
  /* About dialog                                                           */
  /* ---------------------------------------------------------------------- */

  // Apache 2.0 section 4(a) asks every copy of the program to carry the licence,
  // and a single .exe has nowhere to put a file beside it.  The text therefore
  // lives in assets/LICENSE.txt, is embedded as a resource with the rest of the
  // front end, and is shown here.
  var appVersion = '';       // filled from the host's settings message
  var licenceText = null;    // null = not read yet, '' = the read failed

  function aboutSummaryText() {
    return appVersion ? 'JustViewMD v' + appVersion : 'JustViewMD';
  }

  function openAboutDialog() {
    closeContextMenu();
    aboutSummary.textContent = aboutSummaryText();
    aboutDialog.hidden = false;
    aboutReturnFocus = document.activeElement;
    aboutCloseButton.focus();

    if (licenceText !== null) {
      if (licenceText) {
        aboutLicence.textContent = licenceText;
      }
      return;
    }

    aboutLicence.textContent = 'Loading the licence text\u2026';
    fetch('LICENSE.txt').then(function (response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      return response.text();
    }).then(function (text) {
      licenceText = text;
      aboutLicence.textContent = text;
    }).catch(function () {
      licenceText = '';
      aboutLicence.textContent =
        'The licence text could not be read from the program. JustViewMD is ' +
        'released under the Apache License 2.0, Copyright 2026 finnuen; the ' +
        'full text is the LICENSE file in the JustViewMD repository.';
    });
  }

  function closeAboutDialog() {
    if (aboutDialog.hidden) {
      return;
    }
    aboutDialog.hidden = true;
    if (aboutReturnFocus && document.contains(aboutReturnFocus)) {
      aboutReturnFocus.focus();
    }
    aboutReturnFocus = null;
  }

  function initAboutDialog() {
    aboutCloseButton.addEventListener('click', closeAboutDialog);
    // The backdrop is the dialog's parent, so a click that lands on it is a
    // click outside the frame.  On release, like every other control: a press
    // that started on the frame and slid off its edge does not close it.
    aboutDialog.addEventListener('click', function (event) {
      if (event.target === aboutDialog) {
        closeAboutDialog();
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Context menu, menu bar menus                                           */
  /* ---------------------------------------------------------------------- */

  var activeMenuName = null;
  var menuAnchor = { x: 0, y: 0 };   // where the open menu sits, in client pixels
  var menubarOpenTimer = null;       // opens the menu under a resting pointer
  var menubarCloseTimer = null;      // closes it once the pointer has left both

  function closeContextMenu() {
    if (!contextMenu.hidden) {
      contextMenu.hidden = true;
      contextMenu.innerHTML = '';
    }
    activeMenuName = null;
    Object.keys(menuButtons).forEach(function (name) {
      if (menuButtons[name]) {
        menuButtons[name].setAttribute('aria-expanded', 'false');
      }
    });
  }

  // A menu opened while the pointer was on its way out must not be closed by
  // the timer that leaving the previous one started.
  function cancelMenubarClose() {
    if (menubarCloseTimer) {
      clearTimeout(menubarCloseTimer);
      menubarCloseTimer = null;
    }
  }

  // Builds the rows of a menu.  A checkable row leaves the menu open when it
  // is clicked (a switch in the Options menu is usually one of several), and
  // the menu is redrawn from fresh state so the tick follows the change.
  function buildMenu(items) {
    contextMenu.innerHTML = '';
    items.forEach(function (item) {
      if (item.separator) {
        var separator = document.createElement('div');
        separator.className = 'menu-separator';
        contextMenu.appendChild(separator);
        return;
      }
      var row = document.createElement('div');
      row.className = 'menu-item' + (item.checked ? ' is-checked' : '');
      row.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
      if (item.checked !== undefined) {
        row.setAttribute('aria-checked', item.checked ? 'true' : 'false');
      }
      row.setAttribute('aria-disabled', item.disabled ? 'true' : 'false');
      var label = document.createElement('span');
      label.textContent = item.label;
      row.appendChild(label);
      if (item.shortcut) {
        var shortcut = document.createElement('span');
        shortcut.className = 'menu-shortcut';
        shortcut.textContent = item.shortcut;
        row.appendChild(shortcut);
      }
      if (!item.disabled) {
        row.addEventListener('mouseup', function (event) {
          event.preventDefault();
          event.stopPropagation();
          var keepOpen = item.checked !== undefined && activeMenuName !== null;
          if (!keepOpen) {
            closeContextMenu();
          }
          item.action();
          if (keepOpen) {
            refreshOpenMenu();
          }
        });
      }
      contextMenu.appendChild(row);
    });
  }

  // Redraws the menu on screen from the current settings, without moving it.
  function refreshOpenMenu() {
    if (!activeMenuName || contextMenu.hidden) {
      return;
    }
    openContextMenu(menuAnchor.x, menuAnchor.y, menuItemsFor(activeMenuName), activeMenuName);
  }

  function openContextMenu(clientX, clientY, items, menuName) {
    buildMenu(items);

    contextMenu.hidden = false;
    var width = contextMenu.offsetWidth;
    var height = contextMenu.offsetHeight;
    contextMenu.style.left = clamp(clientX, 4, window.innerWidth - width - 4) + 'px';
    contextMenu.style.top = clamp(clientY, 4, window.innerHeight - height - 4) + 'px';
    menuAnchor.x = clientX;
    menuAnchor.y = clientY;

    activeMenuName = menuName || null;
    Object.keys(menuButtons).forEach(function (name) {
      if (menuButtons[name]) {
        menuButtons[name].setAttribute('aria-expanded',
          (activeMenuName === name) ? 'true' : 'false');
      }
    });
  }

  // The three pull-down menus of the menu bar.
  function menuItemsFor(name) {
    var settings = state.settings;
    var hasSelection = editor.selectionEnd !== editor.selectionStart;
    var items = [];

    if (name === 'file') {
      items.push({ label: 'New Tab', shortcut: 'Ctrl+T',
        action: function () { postToHost({ type: 'newTab' }); } });
      items.push({ label: 'Open File\u2026', shortcut: 'Ctrl+O',
        action: function () { postToHost({ type: 'open' }); } });
      items.push({ separator: true });
      items.push({ label: 'Save', shortcut: 'Ctrl+S', action: saveActive });
      items.push({ label: 'Save As\u2026', shortcut: 'Ctrl+Shift+S', action: saveActiveAs });
      items.push({ label: 'Reload from Disk',
        disabled: !activeTab() || !activeTab().path,
        action: function () { postToHost({ type: 'reload' }); } });
      items.push({ separator: true });
      items.push({ label: 'Print\u2026', shortcut: 'Ctrl+P',
        action: function () { postToHost({ type: 'print' }); } });
      items.push({ label: 'Save as PDF\u2026',
        action: function () { postToHost({ type: 'exportPdf' }); } });
      items.push({ separator: true });
      items.push({ label: 'Close Tab', shortcut: 'Ctrl+W',
        action: function () { requestCloseTab(state.active); } });
      items.push({ label: 'Close All Tabs',
        action: function () { syncEditorIntoTab(); postToHost({ type: 'closeAll' }); } });
      return items;
    }

    if (name === 'edit') {
      items.push({ label: 'Undo', shortcut: 'Ctrl+Z', action: function () {
        editor.focus();
        document.execCommand('undo');
        syncEditorIntoTab();
        updateCounts();
        scheduleRender();
      } });
      items.push({ label: 'Redo', shortcut: 'Ctrl+Y', action: function () {
        editor.focus();
        document.execCommand('redo');
        syncEditorIntoTab();
        updateCounts();
        scheduleRender();
      } });
      items.push({ separator: true });
      items.push({ label: 'Cut', shortcut: 'Ctrl+X', disabled: !hasSelection, action: cutSelection });
      items.push({ label: 'Copy', shortcut: 'Ctrl+C', disabled: !hasSelection, action: copySelection });
      items.push({ label: 'Paste', shortcut: 'Ctrl+V', action: pasteFromClipboard });
      items.push({ label: 'Select All', shortcut: 'Ctrl+A', action: function () {
        editor.focus();
        editor.select();
        updateCursorStatus();
        renderGutter();
      } });
      items.push({ separator: true });
      items.push({ label: 'Find\u2026', shortcut: 'Ctrl+F', action: function () { openFindBar(false); } });
      items.push({ label: 'Find and Replace\u2026', shortcut: 'Ctrl+H', action: function () { openFindBar(true); } });
      return items;
    }

    // Options
    items.push({ label: 'Split View', shortcut: 'Ctrl+1', checked: settings.viewMode === 'split',
      action: function () { setViewMode('split', true); } });
    items.push({ label: 'Editor Only', shortcut: 'Ctrl+2', checked: settings.viewMode === 'editor',
      action: function () { setViewMode('editor', true); } });
    items.push({ label: 'Preview Only', shortcut: 'Ctrl+3', checked: settings.viewMode === 'preview',
      action: function () { setViewMode('preview', true); } });
    items.push({ separator: true });
    items.push({ label: 'Zoom In', shortcut: 'Ctrl++',
      action: function () { requestZoom('zoomIn'); } });
    items.push({ label: 'Zoom Out', shortcut: 'Ctrl+-',
      action: function () { requestZoom('zoomOut'); } });
    items.push({ label: 'Reset Zoom', shortcut: 'Ctrl+0',
      action: function () { requestZoom('zoomReset'); } });
    items.push({ separator: true });
    items.push({ label: 'Line Wrapping', checked: state.wrapLines,
      action: function () { setWrapLines(!state.wrapLines, true); } });
    items.push({ separator: true });
    items.push({ label: 'Start with Blank', checked: settings.startBlank,
      action: function () { setStartBlank(!settings.startBlank); } });
    items.push({ label: 'Set as Default for .md Files', checked: settings.defaultApp,
      action: function () { setDefaultApp(!settings.defaultApp); } });
    items.push({ label: 'Dark Mode', checked: settings.dark,
      action: function () { setDarkMode(!settings.dark, true); } });
    items.push({ separator: true });
    items.push({ label: imageCacheLabel(), disabled: true });
    items.push({ label: 'Open cache folder',
      action: function () { postToHost({ type: 'openCacheFolder' }); } });
    items.push({ separator: true });
    items.push({ label: 'Windows Default Apps\u2026',
      action: function () { postToHost({ type: 'openDefaultApps' }); } });
    items.push({ label: 'Check for update...', shortcut: updateHint(),
      action: function () { postToHost({ type: 'checkForUpdate' }); } });
    if (updateState && updateState.state === 'available' && updateState.latest) {
      items.push({ label: 'Get JustViewMD ' + updateState.latest + '...',
        action: function () { postToHost({ type: 'openReleasePage' }); } });
    }
    items.push({ separator: true });
    items.push({ label: 'About JustViewMD', action: openAboutDialog });
    return items;
  }

  function toggleMenubarMenu(name) {
    cancelMenubarClose();
    if (activeMenuName === name && !contextMenu.hidden) {
      closeContextMenu();
      return;
    }
    var button = menuButtons[name];
    if (!button) {
      return;
    }
    var bounds = button.getBoundingClientRect();
    if (name === 'options') {
      // The folder can be emptied in Explorer between two openings, so the size
      // shown in the menu is asked for afresh every time it is pulled down.
      postToHost({ type: 'cacheStats' });
    }
    openContextMenu(bounds.left, bounds.bottom + 1, menuItemsFor(name), name);
  }

  function copySelection() {
    var selection = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    if (!selection) {
      return;
    }
    var copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    if (!copied && navigator.clipboard) {
      navigator.clipboard.writeText(selection).catch(function () {
        showToast('Copy failed', true);
      });
    }
  }

  function cutSelection() {
    var selection = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    if (!selection) {
      return;
    }
    copySelection();
    replaceSelectionWith('');
  }

  function pasteFromClipboard() {
    var finish = function (text) {
      if (text) {
        insertTextAtCursor(text);
      } else {
        showToast('Nothing to paste', true);
      }
    };
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(finish).catch(function () {
        showToast('Press Ctrl+V to paste', true);
      });
    } else {
      showToast('Press Ctrl+V to paste', true);
    }
  }

  function toggleWrapLines() {
    setWrapLines(!state.wrapLines, true);
  }

  function showContextMenu(event) {
    event.preventDefault();
    var inEditor = (event.target === editor);
    var hasSelection = inEditor && (editor.selectionEnd !== editor.selectionStart);
    var items = [];

    if (inEditor) {
      items.push({
        label: 'Undo', shortcut: 'Ctrl+Z',
        action: function () { editor.focus(); document.execCommand('undo'); syncEditorIntoTab(); updateCounts(); scheduleRender(); }
      });
      items.push({
        label: 'Redo', shortcut: 'Ctrl+Y',
        action: function () { editor.focus(); document.execCommand('redo'); syncEditorIntoTab(); updateCounts(); scheduleRender(); }
      });
      items.push({ separator: true });
      items.push({ label: 'Cut', shortcut: 'Ctrl+X', disabled: !hasSelection, action: cutSelection });
      items.push({ label: 'Copy', shortcut: 'Ctrl+C', disabled: !hasSelection, action: copySelection });
      items.push({ label: 'Paste', shortcut: 'Ctrl+V', action: pasteFromClipboard });
      items.push({
        label: 'Select All', shortcut: 'Ctrl+A',
        action: function () { editor.focus(); editor.select(); updateCursorStatus(); renderGutter(); }
      });
      items.push({ separator: true });
      items.push({ label: 'Find\u2026', shortcut: 'Ctrl+F', action: function () { openFindBar(false); } });
      items.push({ label: 'Find and Replace\u2026', shortcut: 'Ctrl+H', action: function () { openFindBar(true); } });
      items.push({ separator: true });
      items.push({
        label: state.wrapLines ? 'Turn off line wrapping' : 'Turn on line wrapping',
        action: toggleWrapLines
      });
      items.push({ separator: true });
    } else {
      items.push({
        label: 'Copy', shortcut: 'Ctrl+C',
        action: function () {
          var selection = String(window.getSelection() || '');
          if (selection && navigator.clipboard) {
            navigator.clipboard.writeText(selection).catch(function () { /* ignore */ });
          }
        }
      });
      items.push({
        label: 'Select All', shortcut: 'Ctrl+A',
        action: function () {
          var range = document.createRange();
          range.selectNodeContents(markdown);
          var selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
      });
      items.push({ separator: true });
      items.push({ label: 'Find\u2026', shortcut: 'Ctrl+F', action: function () { openFindBar(false); } });
      items.push({ separator: true });
    }

    items.push({
      label: 'Open File\u2026', shortcut: 'Ctrl+O',
      action: function () { postToHost({ type: 'open' }); }
    });
    items.push({ label: 'Save', shortcut: 'Ctrl+S', action: saveActive });
    items.push({ label: 'Save As\u2026', shortcut: 'Ctrl+Shift+S', action: saveActiveAs });
    items.push({ label: 'Reload from Disk', disabled: !activeTab() || !activeTab().path,
      action: function () { postToHost({ type: 'reload' }); } });
    items.push({ separator: true });
    items.push({ label: 'New Tab', shortcut: 'Ctrl+T',
      action: function () { postToHost({ type: 'newTab' }); } });
    items.push({ label: 'Close Tab', shortcut: 'Ctrl+W',
      action: function () { requestCloseTab(state.active); } });

    openContextMenu(event.clientX, event.clientY, items);
  }

  /* ---------------------------------------------------------------------- */
  /* Wiring                                                                 */
  /* ---------------------------------------------------------------------- */

  function initMermaid(dark) {
    if (!window.mermaid) {
      return;
    }
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: dark ? 'dark' : 'default',
        /* The dark palette, the same colours the preview uses: muted canvas,
           a raised box, its usual border and accent.  textColor is what
           Mermaid paints edge labels with; without it they come out
           near-black on the dark page. */
        themeVariables: dark ? {
          darkMode: true,
          background: '#151b23',
          primaryColor: '#212830',
          primaryTextColor: '#f0f6fc',
          primaryBorderColor: '#3d444d',
          lineColor: '#9198a1',
          secondaryColor: '#2a313c',
          tertiaryColor: '#0d1117',
          textColor: '#f0f6fc',
          mainBkg: '#212830',
          nodeBorder: '#3d444d',
          edgeLabelBackground: '#0d1117',
          clusterBkg: '#151b23',
          clusterBorder: '#3d444d'
        } : {
          darkMode: false,
          background: '#f6f8fa',
          primaryColor: '#dbe7fb',
          primaryTextColor: '#1f2328',
          primaryBorderColor: '#8bb2ec',
          lineColor: '#57606a',
          secondaryColor: '#eef2f6',
          tertiaryColor: '#f6f8fa'
        },
        fontFamily: 'Segoe UI, system-ui, sans-serif',
        flowchart: { htmlLabels: false, curve: 'basis' },
        sequence: { useMaxWidth: true },
        gantt: { useMaxWidth: true }
      });
      mermaidReady = true;
    } catch (error) {
      mermaidReady = false;
    }
  }

  function initDivider() {
    var dragging = false;

    divider.addEventListener('pointerdown', function (event) {
      dragging = true;
      divider.classList.add('is-dragging');
      try {
        divider.setPointerCapture(event.pointerId);
      } catch (error) {
        /* ignore */
      }
      event.preventDefault();
    });

    divider.addEventListener('pointermove', function (event) {
      if (!dragging) {
        return;
      }
      var bounds = workspace.getBoundingClientRect();
      var ratio = clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0.15, 0.85);
      workspace.style.setProperty('--editor-width', (ratio * 100).toFixed(2) + '%');
    });

    function stopDragging(event) {
      if (!dragging) {
        return;
      }
      dragging = false;
      divider.classList.remove('is-dragging');
      try {
        divider.releasePointerCapture(event.pointerId);
      } catch (error) {
        /* ignore */
      }
      afterResize();
    }

    divider.addEventListener('pointerup', stopDragging);
    divider.addEventListener('pointercancel', stopDragging);
    divider.addEventListener('dblclick', function () {
      workspace.style.setProperty('--editor-width', '50%');
      afterResize();
    });
    divider.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }
      event.preventDefault();
      var current = parseFloat(getComputedStyle(workspace).getPropertyValue('--editor-width')) || 50;
      var next = clamp(current + (event.key === 'ArrowLeft' ? -2 : 2), 15, 85);
      workspace.style.setProperty('--editor-width', next.toFixed(2) + '%');
      afterResize();
    });
  }

  function afterResize() {
    metrics.text = null;
    // From here until the callback runs, a scroll event belongs to the browser
    // reacting to the new layout, not to the reader: it must not overwrite the
    // place that is about to be restored.  The deadline is only a safety net
    // for a window that is not painting, where the callback never runs.
    layoutSettlingUntil = performance.now() + 1000;
    requestAnimationFrame(function () {
      layoutSettlingUntil = 0;
      renderGutter();
      // Whatever moved the layout - a zoom, the divider, a new window size, a
      // wrap change - the reader keeps the line they were on.  With no place
      // yet (before the first render) the panes simply follow the editor.
      settlePlace();
      scheduleFindTicks();
    });
  }

  function initEditor() {
    editor.addEventListener('input', function () {
      syncEditorIntoTab();
      setDirty(true);
      scheduleSnapshot();
      scheduleRender();
    });

    editor.addEventListener('scroll', function () {
      if (state.settings.viewMode === 'preview' || pendingPlace ||
          performance.now() < layoutSettlingUntil) {
        // A hidden textarea has no position worth following, and while a
        // layout is settling these scroll events are the browser clamping it.
        programmatic.editor = editor.scrollTop;
      } else if (Math.abs(editor.scrollTop - programmatic.editor) >= 1) {
        syncFromEditor();
        rememberPlace(editor);
        revealJumpButtons();
      }
      renderGutter();
      syncFindHighlight();
      followJumpScroll();
    });

    editor.addEventListener('keydown', function (event) {
      var shortcut = (event.key || '').toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey &&
          (shortcut === 'b' || shortcut === 'i' || shortcut === 'k')) {
        event.preventDefault();
        applyFormat(shortcut === 'b' ? 'bold' : (shortcut === 'i' ? 'italic' : 'link'));
        return;
      }
      if (event.key === 'Tab') {
        // Ctrl+Tab (tab switching) is handled by the document-level listener
        // and has already been taken care of by the time this runs.
        if (event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        var start = editor.selectionStart;
        var end = editor.selectionEnd;
        var value = editor.value;
        if (!event.shiftKey && start === end) {
          replaceSelectionWith(INDENT);
          return;
        }
        var lineStart = value.lastIndexOf('\n', start - 1) + 1;
        var block = value.slice(lineStart, end);
        var updated;
        var delta;
        if (event.shiftKey) {
          updated = block.replace(/^(\t| {1,2})/gm, '');
          delta = -1 * (block.length - updated.length);
        } else {
          updated = block.replace(/^/gm, INDENT);
          delta = updated.length - block.length;
        }
        var firstLineDedent = 0;
        var updatedLines = updated.split('\n');
        if (event.shiftKey && updatedLines.length) {
          var removed = /^(?:\t| {1,2})/.exec(block.split('\n')[0]);
          firstLineDedent = removed ? removed[0].length : 0;
        } else {
          firstLineDedent = -INDENT.length;
        }
        var selectionStart = Math.max(lineStart, start + firstLineDedent);
        var selectionEnd = Math.max(selectionStart, end + delta);
        var inserted = false;
        try {
          inserted = document.execCommand('insertText', false, updated);
        } catch (error) {
          inserted = false;
        }
        if (!inserted) {
          editor.value = value.slice(0, lineStart) + updated + value.slice(end);
        }
        editor.setSelectionRange(selectionStart, selectionEnd);
        markEdited();
        return;
      }

      if (event.key === 'Escape') {
        closeContextMenu();
        if (find.open) {
          closeFindBar();
        }
      }
    });

    editor.addEventListener('click', function () {
      updateCursorStatus();
      renderGutter();
    });
    editor.addEventListener('keyup', function () {
      updateCursorStatus();
      renderGutter();
    });
    editor.addEventListener('select', function () {
      updateCursorStatus();
      schedulePreviewSelection();
    });
    document.addEventListener('selectionchange', function () {
      if (document.activeElement === editor) {
        updateCursorStatus();
        schedulePreviewSelection();
        return;
      }
      // A selection in the page that goes away takes the highlight with it, and
      // the source it pointed at is let go.  A release does not always reach the
      // preview: a click on its scrollbar, on the status bar, anywhere outside
      // the document collapses the selection without a mouseup in the pane.
      var page = window.getSelection();
      if (previewSelectionHits.length && (!page || !/\S/.test(page.toString()))) {
        clearPreviewSelectionHits();
        if (editor.selectionStart !== editor.selectionEnd) {
          editor.setSelectionRange(editor.selectionStart, editor.selectionStart);
        }
      }
    });

    previewViewport.addEventListener('scroll', function () {
      if (state.settings.viewMode === 'editor' || pendingPlace ||
          performance.now() < layoutSettlingUntil) {
        programmatic.preview = previewViewport.scrollTop;
      } else if (Math.abs(previewViewport.scrollTop - programmatic.preview) >= 1) {
        syncFromPreview();
        rememberPlace(previewViewport);
        revealJumpButtons();
      }
      followJumpScroll();
    });

    // The reverse direction runs on release, not on selectionchange: mapping a
    // drag would take the focus out of the preview mid-gesture and end the
    // selection the reader is still making.
    //
    // An image or a link can also be dragged out of the page, and dragging is a
    // different gesture: it must not select anything in the editor.  The flag is
    // cleared when a gesture starts and set by the drag the gesture turns into,
    // because dragend arrives before the mouseup that ends it.
    previewViewport.addEventListener('mousedown', function (event) {
      if (event.button === 0) {
        previewDragging = false;
      }
    });
    previewViewport.addEventListener('dragstart', function (event) {
      // A drag out of the page is not a gesture this program offers, and it is
      // the one way a release could turn into a drop: the editor holds the
      // focus, so an image or a link dragged across the window can land in the
      // text.  Images and links therefore do not start a drag.
      var target = event.target;
      if (target && target.closest && target.closest('img, a')) {
        event.preventDefault();
        return;
      }
      previewDragging = true;
    });
    previewViewport.addEventListener('mouseup', function (event) {
      if (event.button !== 0) {
        return;
      }
      if (previewDragging) {
        return;
      }
      if (event.target.closest && event.target.closest('.code-copy')) {
        return;  // the copy button is not a selection
      }
      reflectPreviewSelection();
    });

    editor.addEventListener('contextmenu', showContextMenu);
    previewViewport.addEventListener('contextmenu', showContextMenu);

    markdown.addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey ||
          event.shiftKey || event.altKey) {
        return;
      }
      var link = event.target.closest ? event.target.closest('a') : null;
      if (!link) {
        return;
      }
      var href = link.getAttribute('href') || '';
      if (href.charAt(0) === '#') {
        event.preventDefault();
        scrollPreviewToFragment(href);
        return;
      }
      // Nothing in a document navigates the window: the page is the program.
      event.preventDefault();
      followLink(href);
    });

    // The middle button is a click too, and the browser would otherwise open a
    // window of its own for the address.
    markdown.addEventListener('auxclick', function (event) {
      if (event.defaultPrevented || event.button !== 1) {
        return;
      }
      var link = event.target.closest ? event.target.closest('a') : null;
      if (!link) {
        return;
      }
      var href = link.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') {
        return;
      }
      event.preventDefault();
      followLink(href);
    });

    document.addEventListener('mousedown', function (event) {
      if (!contextMenu.hidden && !contextMenu.contains(event.target)) {
        closeContextMenu();
      }
    }, true);
    // Escape closes an open menu wherever the focus happens to be: the menu
    // rows never take focus, so the editor-scoped handler cannot be relied on.
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || event.isComposing) {
        return;
      }
      if (!aboutDialog.hidden) {
        // The dialog is modal: the key is spent here, so nothing behind it
        // reacts to the same press.
        event.preventDefault();
        closeAboutDialog();
        return;
      }
      if (!contextMenu.hidden) {
        closeContextMenu();
      }
    }, true);
    window.addEventListener('blur', function () {
      closeContextMenu();
      flushSnapshot();
    });
    window.addEventListener('resize', afterResize);

    document.addEventListener('keydown', function (event) {
      if (event.defaultPrevented) {
        return;
      }
      // The About dialog is modal: while it is open the shortcuts behind it do
      // nothing, and Escape has already been spent closing it.
      if (!aboutDialog.hidden) {
        return;
      }
      var key = (event.key || '').toLowerCase();

      if (event.key === 'Escape' && find.open) {
        event.preventDefault();
        closeFindBar();
        return;
      }

      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        if (key === 'f' || key === 'e' || key === 'o') {
          event.preventDefault();
          toggleMenubarMenu(key === 'f' ? 'file' : (key === 'e' ? 'edit' : 'options'));
        }
        return;
      }

      // F3 works without any modifier, exactly like every other editor.
      if (event.key === 'F3' && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        if (!find.open && find.query) {
          openFindBar(false);
        }
        findNext(event.shiftKey ? -1 : 1);
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      if (key === 'o') {
        event.preventDefault();
        postToHost({ type: 'open' });
      } else if (key === 's') {
        event.preventDefault();
        saveActiveAsOrSave(event.shiftKey);
      } else if (key === 'n' || key === 't') {
        event.preventDefault();
        postToHost({ type: 'newTab' });
      } else if (key === 'w') {
        event.preventDefault();
        requestCloseTab(state.active);
      } else if (key === 'tab') {
        event.preventDefault();
        cycleTab(event.shiftKey ? -1 : 1);
      } else if (key === 'f') {
        event.preventDefault();
        openFindBar(false);
      } else if (key === 'p') {
        event.preventDefault();
        postToHost({ type: 'print' });
      } else if (key === 'h') {
        event.preventDefault();
        openFindBar(true);
      } else if (key === '1' || key === '2' || key === '3') {
        event.preventDefault();
        setViewMode(key === '1' ? 'split' : (key === '2' ? 'editor' : 'preview'), true);
      } else if (key === '=' || key === '+') {
        event.preventDefault();
        requestZoom('zoomIn');
      } else if (key === '-') {
        event.preventDefault();
        requestZoom('zoomOut');
      } else if (key === '0') {
        event.preventDefault();
        requestZoom('zoomReset');
      }
    }, true);

    document.addEventListener('wheel', function (event) {
      if (!event.ctrlKey) {
        return;
      }
      event.preventDefault();
      requestZoom(event.deltaY < 0 ? 'zoomIn' : 'zoomOut');
    }, { passive: false });

    window.addEventListener('error', function (event) {
      postToHost({ type: 'log', text: 'JavaScript error: ' + (event.message || '') });
    });
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
      postToHost({ type: 'log', text: 'Unhandled rejection: ' + reason });
    });
  }

  function initTabs() {
    // The strip can overflow once there are enough tabs: keep the scrollbar
    // state right when the window is resized, and let a plain vertical wheel
    // scroll the tabs sideways while the pointer is over them.
    window.addEventListener('resize', updateTabOverflow);

    if (tabScroller) {
      tabScroller.addEventListener('wheel', function (event) {
        if (tabScroller.scrollWidth <= tabScroller.clientWidth) {
          return;
        }
        var factor = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? 400 : 1);
        var delta = event.deltaY * factor;
        if (!delta || Math.abs(delta) <= Math.abs(event.deltaX)) {
          return;
        }
        tabScroller.scrollLeft += delta;
        event.preventDefault();
      }, { passive: false });
    }

    // The + button opens a new tab.  Suppressing the mousedown default keeps
    // the caret and selection in the editor; the click itself still fires, so
    // the button works from the keyboard as well.
    tabAdd.addEventListener('mousedown', function (event) {
      if (event.button === 0) {
        event.preventDefault();
      }
    });
    tabAdd.addEventListener('click', function () {
      postToHost({ type: 'newTab' });
    });

    tabList.addEventListener('mousedown', function (event) {
      var tab = event.target.closest ? event.target.closest('.tab') : null;
      if (!tab) {
        return;
      }
      var index = Number(tab.getAttribute('data-index'));
      // The close button acts on release, not on press: pressing it only arms
      // it, and a press that slides off before the release is cancelled, the
      // way a Win32 button behaves.  The default is still suppressed so the
      // press neither selects the tab nor takes the caret out of the editor.
      if (event.target.closest('.tab-close')) {
        event.preventDefault();
        return;
      }
      if (event.button === 1) {
        // Middle click closes a tab too, and also on release, over the tab the
        // press started on.
        event.preventDefault();
        middlePressTab = tab;
        return;
      }
      if (event.button === 0) {
        event.preventDefault();
        selectTab(index, true);
        // Selecting on mousedown is what makes switching tabs feel instant; the
        // press only becomes a drag once the pointer has moved a few pixels.
        var pressed = state.tabs[index];
        if (pressed) {
          tabDrag = { tab: pressed, startX: event.clientX, startY: event.clientY, moving: false };
        }
      }
    });

    // A click is a press and a release on the same control, which is what the
    // browser's click event means: it never fires for a press that was dragged
    // off, so a button cannot be set off by a press the user took back.
    tabList.addEventListener('click', function (event) {
      var close = event.target.closest ? event.target.closest('.tab-close') : null;
      if (!close) {
        return;
      }
      var tab = close.closest('.tab');
      if (!tab) {
        return;
      }
      event.preventDefault();
      requestCloseTab(Number(tab.getAttribute('data-index')));
    });

    // The drag lives on the window rather than on the tab: the pointer may
    // leave the strip - and the tab it started on - without ending it.
    window.addEventListener('mousemove', onTabDragMove);
    window.addEventListener('mouseup', endTabDrag);
    window.addEventListener('mouseup', endTabPress);
    window.addEventListener('blur', endTabDrag);
    window.addEventListener('blur', endTabPress);

    tabList.addEventListener('contextmenu', function (event) {
      var tab = event.target.closest ? event.target.closest('.tab') : null;
      if (!tab) {
        return;
      }
      event.preventDefault();
      var index = Number(tab.getAttribute('data-index'));
      openContextMenu(event.clientX, event.clientY, [
        { label: 'Close', shortcut: 'Ctrl+W', action: function () { requestCloseTab(index); } },
        { label: 'Close Others', action: function () {
          syncEditorIntoTab();
          postToHost({ type: 'closeOthers', keep: index });
        } },
        { separator: true },
        { label: 'Copy Full Path', disabled: !state.tabs[index] || !state.tabs[index].path,
          action: function () {
            var path = state.tabs[index].path;
            if (path && navigator.clipboard) {
              navigator.clipboard.writeText(path).catch(function () { /* ignore */ });
              showToast('Path copied', false);
            }
          } }
      ]);
    });
  }

  function initFind() {
    findInput.addEventListener('input', function () {
      find.query = findInput.value;
      refreshFindMatches(false);
    });
    replaceInput.addEventListener('input', function () {
      find.replacement = replaceInput.value;
    });

    findInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        findNext(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeFindBar();
      }
    });
    replaceInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && event.ctrlKey) {
        event.preventDefault();
        if (event.altKey) {
          replaceAllMatches();
        } else {
          replaceCurrent();
        }
      } else if (event.key === 'Enter') {
        event.preventDefault();
        findNext(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeFindBar();
      }
    });

    findNextButton.addEventListener('click', function () { findNext(1); });
    findPrevButton.addEventListener('click', function () { findNext(-1); });
    findCloseButton.addEventListener('click', closeFindBar);
    replaceOneButton.addEventListener('click', replaceCurrent);
    replaceAllButton.addEventListener('click', replaceAllMatches);

    // A bar on the scrollbar goes to that match when it is released, like any
    // other button.  The mousedown only has its default prevented: that is what
    // stops the press from moving the focus out of the find box, and from being
    // read as a drag of the scrollbar, so the user can carry on typing.
    function tickFromEvent(event) {
      var tick = event.target;
      while (tick && tick !== findScroller && !tick.classList.contains('find-tick')) {
        tick = tick.parentNode;
      }
      if (!tick || tick === findScroller || !tick.dataset || tick.dataset.match === undefined) {
        return null;
      }
      return tick;
    }

    findScroller.addEventListener('mousedown', function (event) {
      if (tickFromEvent(event)) {
        event.preventDefault();
      }
    });
    findScroller.addEventListener('click', function (event) {
      var tick = tickFromEvent(event);
      if (!tick) {
        return;
      }
      event.preventDefault();
      goToMatch(parseInt(tick.dataset.match, 10), false);
    });

    findCaseButton.addEventListener('click', function () {
      find.caseSensitive = !find.caseSensitive;
      findCaseButton.classList.toggle('is-on', find.caseSensitive);
      refreshFindMatches(true);
    });
    findWordButton.addEventListener('click', function () {
      find.wholeWord = !find.wholeWord;
      findWordButton.classList.toggle('is-on', find.wholeWord);
      refreshFindMatches(true);
    });
    findRegexButton.addEventListener('click', function () {
      find.regex = !find.regex;
      findRegexButton.classList.toggle('is-on', find.regex);
      refreshFindMatches(true);
    });

    // The preview changes height without any window resize: a picture arrives
    // from the cache, a diagram replaces its source.  Bars measured before that
    // arrive are left pointing at lines the matches are not on, so the content
    // is watched as well as the window.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () {
        if (find.open) {
          scheduleFindTicks();
        }
      }).observe(markdown);
    }
  }

  function initMenubar() {
    function cancelOpen() {
      if (menubarOpenTimer) {
        clearTimeout(menubarOpenTimer);
        menubarOpenTimer = null;
      }
    }

    // Leaving a button is not leaving the menu: the pointer is usually on its
    // way down into it, one pixel below, so the close waits a moment and is
    // called off the moment the pointer reaches the menu or another button.
    function scheduleClose() {
      cancelMenubarClose();
      menubarCloseTimer = setTimeout(function () {
        menubarCloseTimer = null;
        closeContextMenu();
      }, MENUBAR_CLOSE_MS);
    }

    Object.keys(menuButtons).forEach(function (name) {
      var button = menuButtons[name];
      if (!button) {
        return;
      }
      // A click still opens (or closes) at once: the pointer may not have
      // rested long enough to open by hover, and the keyboard arrives here too.
      button.addEventListener('mousedown', function (event) {
        event.preventDefault();
        cancelOpen();
        cancelMenubarClose();
        toggleMenubarMenu(name);
      });
      button.addEventListener('mouseenter', function () {
        cancelMenubarClose();
        if (activeMenuName && activeMenuName !== name && !contextMenu.hidden) {
          // A menu is already down: sliding along the bar changes it at once.
          cancelOpen();
          toggleMenubarMenu(name);
          return;
        }
        if (activeMenuName === name && !contextMenu.hidden) {
          return;   // its own menu is already down
        }
        // Resting on a button opens its menu.  Passing over the bar on the way
        // somewhere else does not, which is what the delay is for.
        cancelOpen();
        menubarOpenTimer = setTimeout(function () {
          menubarOpenTimer = null;
          if (button.matches(':hover')) {
            toggleMenubarMenu(name);
          }
        }, MENUBAR_HOVER_MS);
      });
      button.addEventListener('mouseleave', function () {
        cancelOpen();
        if (!contextMenu.hidden) {
          scheduleClose();
        }
      });
    });

    // The menu holds itself open while the pointer is on it, and closes a
    // moment after the pointer has left it and the menu bar.
    contextMenu.addEventListener('mouseenter', cancelMenubarClose);
    contextMenu.addEventListener('mouseleave', function () {
      if (!contextMenu.hidden) {
        scheduleClose();
      }
    });
  }

  function boot() {
    if (window.marked) {
      // A single newline is a soft break: the two lines join in one paragraph,
      // as they do in the dialect this reads.  A line that really wants to end
      // carries two spaces or a backslash, or an explicit <br>.
      window.marked.use({ gfm: true, breaks: false, extensions: [footnoteExtension] });
    }

    document.documentElement.dataset.theme = state.settings.dark ? 'dark' : 'light';
    initMermaid(state.settings.dark);
    initDivider();
    initEditor();
    initFormatBar();
    initJumpButtons();
    initTabs();
    initFind();
    initMenubar();
    initAboutDialog();
    updateTabStrip();

    if (host) {
      host.addEventListener('message', function (event) {
        handleHostMessage(event.data);
      });
    }

    // The host sends the first document once the engine is up.  If the page is
    // opened directly (development), fall back to the welcome document.
    fetch('welcome.md').then(function (response) {
      return response.ok ? response.text() : '';
    }).then(function (text) {
      if (!bootLoaded && text) {
        if (!state.tabs.length) {
          state.tabs.push(blankTab('welcome.md'));
          state.active = 0;
        }
        activeTab().text = text;
        showTab(state.active, false, false);
      }
      if (!bootLoaded) {
        renderNow();
      }
    }).catch(function () {
      if (!bootLoaded) {
        renderNow();
      }
    });

    if (host) {
      postToHost({ type: 'ready' });
    } else {
      updateCounts();
    }
  }

  // Called from the host while a file is dragged over the window.
  window.__justviewmdDragOverlay = function (visible) {
    dropOverlay.hidden = !visible;
  };

  // Small surface for debugging and manual testing.
  window.__justviewmd = {
    render: renderNow,
    setContent: function (text) {
      if (!state.tabs.length) {
        state.tabs.push(blankTab());
        state.active = 0;
      }
      editor.value = String(text);
      bootLoaded = true;
      metrics.text = null;
      syncEditorIntoTab();
      setDirty(true);
      editor.scrollTop = 0;
      renderNow();
    },
    getState: function () {
      return {
        active: state.active,
        tabs: state.tabs.map(function (tab) {
          return {
            name: tab.name,
            path: tab.path,
            dirty: tab.dirty,
            length: tab.text ? tab.text.length : 0
          };
        }),
        settings: state.settings,
        find: {
          open: find.open,
          query: find.query,
          matches: find.matches.length,
          current: find.current,
          invalid: find.invalid
        },
        zoom: state.zoom
      };
    },
    getText: function () {
      return editor.value;
    },
    // Drives the host protocol from a test page or the developer console.
    handle: handleHostMessage,
    outgoing: function () {
      return outgoing.slice();
    },
    // Scroll-sync internals: how many top level blocks were paired with a
    // source line.  A zero anchor count means the proportional fallback is in
    // use, which is worth investigating.
    getScrollSync: function () {
      return {
        anchors: anchors.length,
        blocks: markdown.children.length,
        sourceLines: editor.value.split('\n').length,
        anchorLines: anchors.map(function (entry) { return entry.line; }),
        editorTop: editor.scrollTop,
        previewTop: previewViewport.scrollTop
      };
    }
  };

  boot();
}());
