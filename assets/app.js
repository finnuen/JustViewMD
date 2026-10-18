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
  var HEAVY_SOURCE_BYTES = 1500000; // above this, skip highlighting and diagrams
  var MERMAID_CACHE_LIMIT = 200;
  var MATH_CACHE_LIMIT = 4000;
  var INDENT = '  ';

  /* ---------------------------------------------------------------------- */
  /* Elements                                                               */
  /* ---------------------------------------------------------------------- */

  var editor = document.getElementById('editor');
  var editorViewport = document.getElementById('editorViewport');
  var gutterInner = document.getElementById('gutterInner');
  var markdown = document.getElementById('markdown');
  var previewViewport = document.getElementById('previewViewport');
  var workspace = document.getElementById('workspace');
  var divider = document.getElementById('divider');
  var dropOverlay = document.getElementById('dropOverlay');
  var toastElement = document.getElementById('toast');
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
    wrapLines: true,
    zoom: 1,
    heavy: false,
    settings: {
      viewMode: 'split',       // split | editor | preview
      dark: true,
      keepOpened: false,
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

  // The host checks the releases on GitHub when the window opens and whenever
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
    state.heavy = source.length > HEAVY_SOURCE_BYTES;
    setRenderStatus(state.heavy ? 'Large document' : 'Rendering\u2026', 'busy');

    var started = performance.now();
    mermaidGeneration += 1;
    var generation = mermaidGeneration;

    markdown.innerHTML = renderMarkdown(source);
    highlightCodeBlocks(markdown);
    renderMermaidBlocks(markdown, generation);
    applyRemoteImages(markdown);

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
    syncScrollFrom(editor);
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
      postToHost({ type: 'snapshot', index: state.active, content: editor.value });
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
    programmatic.editor = editor.scrollTop;
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
    tab.text = (typeof data.content === 'string') ? data.content : '';
    tab.path = data.path || '';
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
    var html = '';
    for (var index = 0; index < state.tabs.length; index++) {
      var tab = state.tabs[index];
      var name = tab.name || 'Untitled.md';
      var isActive = (index === state.active);
      html += '<div class="tab' + (isActive ? ' is-active' : '') + (tab.dirty ? ' is-dirty' : '') +
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
    // Keep the active tab in view, leaving the pinned + button its width.
    var activeElement = tabList.querySelector('.tab.is-active');
    if (activeElement) {
      var view = tabScroller.getBoundingClientRect();
      var box = activeElement.getBoundingClientRect();
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
    postToHost({ type: 'dirty', index: state.active, value: next });
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
        postToHost({ type: 'snapshot', index: state.active, content: editor.value });
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

  function goToMatch(index) {
    var count = find.matches.length;
    if (!count) {
      return;
    }
    find.current = ((index % count) + count) % count;
    var match = find.matches[find.current];
    try {
      editor.focus({ preventScroll: true });
    } catch (error) {
      editor.focus();
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
    renderFindHighlights();
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
    if (state.settings.viewMode === 'preview') {
      setViewMode('split', true);
    }
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
    if (document.activeElement === findInput || document.activeElement === replaceInput) {
      editor.focus();
    }
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
      settings.viewMode = data.view;
    }
    if (typeof data.dark === 'boolean') {
      settings.dark = data.dark;
    }
    if (typeof data.keepOpened === 'boolean') {
      settings.keepOpened = data.keepOpened;
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
    applyViewMode();
    applyWrap();
    applyTheme();
    refreshOpenMenu();
  }

  function setViewMode(mode, persist) {
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

  function setKeepOpened(value) {
    state.settings.keepOpened = Boolean(value);
    postSetting('keepOpened', state.settings.keepOpened ? 1 : 0);
    showToast(state.settings.keepOpened
      ? 'Files will be reopened on start'
      : 'Starting with a single empty file', false);
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
  /* Context menu, menu bar menus                                           */
  /* ---------------------------------------------------------------------- */

  var activeMenuName = null;
  var menuAnchor = { x: 0, y: 0 };   // where the open menu sits, in client pixels

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
      action: function () { postToHost({ type: 'zoomIn' }); } });
    items.push({ label: 'Zoom Out', shortcut: 'Ctrl+-',
      action: function () { postToHost({ type: 'zoomOut' }); } });
    items.push({ label: 'Reset Zoom', shortcut: 'Ctrl+0',
      action: function () { postToHost({ type: 'zoomReset' }); } });
    items.push({ separator: true });
    items.push({ label: 'Line Wrapping', checked: state.wrapLines,
      action: function () { setWrapLines(!state.wrapLines, true); } });
    items.push({ separator: true });
    items.push({ label: 'Keep Opened Files', checked: settings.keepOpened,
      action: function () { setKeepOpened(!settings.keepOpened); } });
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
    return items;
  }

  function toggleMenubarMenu(name) {
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
        themeVariables: dark ? {
          darkMode: true,
          background: '#1b1e26',
          primaryColor: '#2b3242',
          primaryTextColor: '#e6e8ee',
          primaryBorderColor: '#3a4254',
          lineColor: '#8b93a7',
          secondaryColor: '#333a4a',
          tertiaryColor: '#242833'
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
    requestAnimationFrame(function () {
      renderGutter();
      syncFromEditor();
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
      if (Math.abs(editor.scrollTop - programmatic.editor) >= 1) {
        syncFromEditor();
      }
      renderGutter();
      syncFindHighlight();
    });

    editor.addEventListener('keydown', function (event) {
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
    });
    document.addEventListener('selectionchange', function () {
      if (document.activeElement === editor) {
        updateCursorStatus();
      }
    });

    previewViewport.addEventListener('scroll', function () {
      if (Math.abs(previewViewport.scrollTop - programmatic.preview) >= 1) {
        syncFromPreview();
      }
    });

    editor.addEventListener('contextmenu', showContextMenu);
    previewViewport.addEventListener('contextmenu', showContextMenu);

    document.addEventListener('mousedown', function (event) {
      if (!contextMenu.hidden && !contextMenu.contains(event.target)) {
        closeContextMenu();
      }
    }, true);
    // Escape closes an open menu wherever the focus happens to be: the menu
    // rows never take focus, so the editor-scoped handler cannot be relied on.
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !event.isComposing && !contextMenu.hidden) {
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
      } else if (key === 'h') {
        event.preventDefault();
        openFindBar(true);
      } else if (key === '1' || key === '2' || key === '3') {
        event.preventDefault();
        setViewMode(key === '1' ? 'split' : (key === '2' ? 'editor' : 'preview'), true);
      } else if (key === '=' || key === '+') {
        event.preventDefault();
        postToHost({ type: 'zoomIn' });
      } else if (key === '-') {
        event.preventDefault();
        postToHost({ type: 'zoomOut' });
      } else if (key === '0') {
        event.preventDefault();
        postToHost({ type: 'zoomReset' });
      }
    }, true);

    document.addEventListener('wheel', function (event) {
      if (!event.ctrlKey) {
        return;
      }
      event.preventDefault();
      postToHost({ type: event.deltaY < 0 ? 'zoomIn' : 'zoomOut' });
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
      if (event.target.closest('.tab-close') || event.button === 1) {
        event.preventDefault();
        requestCloseTab(index);
        return;
      }
      if (event.button === 0) {
        event.preventDefault();
        selectTab(index, true);
      }
    });

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
  }

  function initMenubar() {
    Object.keys(menuButtons).forEach(function (name) {
      var button = menuButtons[name];
      if (!button) {
        return;
      }
      button.addEventListener('mousedown', function (event) {
        event.preventDefault();
        toggleMenubarMenu(name);
      });
      // Once a menu is open, sliding along the menu bar switches menus.
      button.addEventListener('mouseenter', function () {
        if (activeMenuName && activeMenuName !== name && !contextMenu.hidden) {
          toggleMenubarMenu(name);
        }
      });
    });
  }

  function boot() {
    if (window.marked) {
      window.marked.use({ gfm: true, breaks: true, extensions: [footnoteExtension] });
    }

    document.documentElement.dataset.theme = state.settings.dark ? 'dark' : 'light';
    initMermaid(state.settings.dark);
    initDivider();
    initEditor();
    initTabs();
    initFind();
    initMenubar();
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
