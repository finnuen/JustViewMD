# =============================================================================
#  JustViewMD - builds the two .ico files from their PNG artwork
#
#  The artwork is a PNG with an alpha channel; this script renders it into
#  every size Windows asks for (Explorer tiles, the taskbar, Alt+Tab, the title
#  bar) and assembles a proper multi-frame .ico:
#
#    * 16-48 px are stored as uncompressed DIBs, because parts of the shell
#      still refuse the PNG variant at small sizes,
#    * 64 px and up are stored as PNG, which keeps the file small and the
#      gradients clean.
#
#  The application icon (src/app.ico) uses the default settings.  The document
#  icon for .md files is built from its own artwork, which is a page floating in
#  a lot of empty canvas: it is cropped to its content first and then scaled to
#  fill the tile, so the file icon is as large as the icons next to it instead
#  of a small page in a big square.
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
#    powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1 `
#        -SourcePath src\file-icon.png -OutputPath src\file-icon.ico `
#        -CropToContent -SkipRedraw -ContentFill 0.98
# =============================================================================

[CmdletBinding()]
param(
    [string] $SourcePath,
    [string] $OutputPath,
    # Do not redraw the smallest frames from the application's own geometry.
    [switch] $SkipRedraw,
    # Trim the transparent margin of the artwork before scaling.
    [switch] $CropToContent,
    # How much of the tile the artwork fills (1.0 touches two opposite edges).
    [double] $ContentFill = 1.0,
    # Alpha value a pixel needs to count as content when cropping.
    [int] $CropAlphaThreshold = 8
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot     = Split-Path -Parent $scriptDirectory
if (-not $SourcePath) { $SourcePath = Join-Path $projectRoot 'src\app-icon.png' }
if (-not $OutputPath) { $OutputPath = Join-Path $projectRoot 'src\app.ico' }

if (-not (Test-Path -LiteralPath $SourcePath)) {
    throw "Icon source not found: $SourcePath"
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)

# Two frames (16 and 24 px) are redrawn from measured geometry instead of being
# scaled down: a 500 px "M" squeezed into a 16 px tile turns into grey mush, and
# those are the sizes Explorer and the taskbar use the most. 32 px and up are the
# real artwork.
$redrawAtOrBelow = 24

# Measures the alpha bounding box of the artwork.  Used with -CropToContent so
# that a page drawn in the middle of a large empty canvas still ends up as large
# as the icons next to it.
function Get-ContentBounds {
    param(
        [System.Drawing.Image] $Source,
        [int] $Threshold
    )

    $probe = New-Object System.Drawing.Bitmap(
        $Source.Width, $Source.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($probe)
    $graphics.DrawImage($Source, 0, 0, $Source.Width, $Source.Height)
    $graphics.Dispose()

    $rect = New-Object System.Drawing.Rectangle(0, 0, $probe.Width, $probe.Height)
    $data = $probe.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $stride = $data.Stride
        $bytes  = New-Object byte[] ($stride * $probe.Height)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    } finally {
        $probe.UnlockBits($data)
    }
    $width  = $probe.Width
    $height = $probe.Height
    $probe.Dispose()

    $minX = $width; $minY = $height; $maxX = -1; $maxY = -1
    for ($y = 0; $y -lt $height; ++$y) {
        $row = $y * $stride
        for ($x = 0; $x -lt $width; ++$x) {
            if ($bytes[$row + $x * 4 + 3] -ge $Threshold) {
                if ($x -lt $minX) { $minX = $x }
                if ($x -gt $maxX) { $maxX = $x }
                if ($y -lt $minY) { $minY = $y }
                if ($y -gt $maxY) { $maxY = $y }
            }
        }
    }
    if ($maxX -lt 0) {
        throw 'the artwork is completely transparent'
    }
    return (New-Object System.Drawing.Rectangle(
        $minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1)))
}

function Get-ScaledBitmap {
    param(
        [System.Drawing.Image] $Source,
        [int] $Size,
        [System.Drawing.Rectangle] $SourceRect
    )

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode        = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.InterpolationMode    = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode      = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.CompositingQuality   = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)

        # The rectangle the artwork is drawn into.  Without a crop this is the
        # whole tile.  With one, the aspect ratio is kept, so a page stays a page
        # and simply becomes as large as the tile allows.
        $scale = ($Size * $ContentFill) / [Math]::Max($SourceRect.Width, $SourceRect.Height)
        $width  = $SourceRect.Width * $scale
        $height = $SourceRect.Height * $scale
        # Integer destination: this is the one DrawImage overload that takes an
        # ImageAttributes, and the wrap mode it carries is what keeps the edges
        # clean when the artwork is scaled down.
        $destRect = New-Object System.Drawing.Rectangle(
            ([int] [Math]::Round(($Size - $width) / 2.0)),
            ([int] [Math]::Round(($Size - $height) / 2.0)),
            ([int] [Math]::Round($width)),
            ([int] [Math]::Round($height)))

        $attributes = New-Object System.Drawing.Imaging.ImageAttributes
        try {
            $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
            $graphics.DrawImage($Source, $destRect, $SourceRect.X, $SourceRect.Y,
                $SourceRect.Width, $SourceRect.Height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
        } finally {
            $attributes.Dispose()
        }
    } finally {
        $graphics.Dispose()
    }
    return $bitmap
}

# Every number below was measured on the source artwork (500x500, full bleed).
# They are fractions of the tile's side, which keeps the redrawn frames exact
# replicas of the original at any size:
#
#   tile       rounded square, corner radius 0.252, vertical gradient
#              #518CF2 -> #3F64D9
#   "M"        stems 0.316-0.382 and 0.616-0.682, top 0.216, bottom 0.542,
#              diagonals entering at 0.389 / 0.611 and meeting at the baseline
#   chevron    apex 0.771, arm tips 0.646, round caps, thickness 0.054
#
$tileRadius     = 0.252
$tileTopColor   = [System.Drawing.Color]::FromArgb(255, 0x51, 0x8C, 0xF2)
$tileBottomColor= [System.Drawing.Color]::FromArgb(255, 0x3F, 0x64, 0xD9)
$markTop        = 0.216
$markBottom     = 0.542
$stemHalfWidth  = 0.033
$stemLeftCenter = 0.349
$stemRightCenter= 0.651
$diagonalTopX   = 0.389
$chevronTipY    = 0.646
$chevronApexY   = 0.771
$chevronTipX    = 0.398
$chevronThick   = 0.054

function Get-RedrawnBitmap {
    param([int] $Size)

    # At 16 and 24 px the true stroke weights land well under one pixel and the
    # mark washes out, so the strokes are fattened. The tile, the layout and the
    # colours stay the ones from the artwork; the boost was picked by rendering
    # the candidates at 1:1 and judging the letterform.
    $boost = if ($Size -le 16) { 1.5 } else { 1.2 }

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)

        # --- the tile ---------------------------------------------------------
        $diameter = $tileRadius * 2.0 * $Size
        $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
        $tile.AddArc(0, 0, $diameter, $diameter, 180, 90)
        $tile.AddArc($Size - $diameter, 0, $diameter, $diameter, 270, 90)
        $tile.AddArc($Size - $diameter, $Size - $diameter, $diameter, $diameter, 0, 90)
        $tile.AddArc(0, $Size - $diameter, $diameter, $diameter, 90, 90)
        $tile.CloseFigure()

        $tileRect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
        $tileBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            $tileRect, $tileTopColor, $tileBottomColor,
            [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
        $graphics.FillPath($tileBrush, $tile)

        # --- the mark ---------------------------------------------------------
        $markBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)

        $top    = $markTop * $Size
        $bottom = $markBottom * $Size
        $half   = $stemHalfWidth * $boost * $Size
        $height = $bottom - $top

        # Stems: plain rectangles, grown around their centre line.
        foreach ($center in @($stemLeftCenter, $stemRightCenter)) {
            $rect = New-Object System.Drawing.RectangleF(
                ([single] (($center * $Size) - $half)), ([single] $top),
                ([single] ($half * 2.0)), ([single] $height))
            $graphics.FillRectangle($markBrush, $rect)
        }

        # Diagonals: parallelograms from the top edge down to the middle of the
        # baseline. The two of them overlap near the bottom, which is what forms
        # the flat cut at the foot of the "M".
        # The parenthesis around each element are load bearing: the comma binds
        # tighter than the multiplication in PowerShell.
        $centreX = 0.5 * $Size
        $xTopLeft  = $diagonalTopX * $Size
        $xTopRight = $Size - $xTopLeft
        foreach ($xTop in @($xTopLeft, $xTopRight)) {
            $points = @(
                (New-Object System.Drawing.PointF(([single] ($xTop - $half)),    ([single] $top))),
                (New-Object System.Drawing.PointF(([single] ($xTop + $half)),    ([single] $top))),
                (New-Object System.Drawing.PointF(([single] ($centreX + $half)), ([single] $bottom))),
                (New-Object System.Drawing.PointF(([single] ($centreX - $half)), ([single] $bottom)))
            )
            $graphics.FillPolygon($markBrush, $points)
        }

        # Chevron: a round capped two segment stroke.
        $chevronPen = New-Object System.Drawing.Pen(
            [System.Drawing.Color]::White,
            ([single] [Math]::Max(0.9, $chevronThick * $boost * $Size)))
        $chevronPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $chevronPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $chevronPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
        $chevron = @(
            (New-Object System.Drawing.PointF(([single] ($chevronTipX * $Size)), ([single] ($chevronTipY * $Size)))),
            (New-Object System.Drawing.PointF(([single] ($centreX)),             ([single] ($chevronApexY * $Size)))),
            (New-Object System.Drawing.PointF(([single] ((1.0 - $chevronTipX) * $Size)), ([single] ($chevronTipY * $Size))))
        )
        $graphics.DrawLines($chevronPen, $chevron)

        $chevronPen.Dispose()
        $markBrush.Dispose()
        $tileBrush.Dispose()
        $tile.Dispose()
    } finally {
        $graphics.Dispose()
    }
    return $bitmap
}

function Get-BitmapBytes {
    param([System.Drawing.Bitmap] $Bitmap)

    $rect = New-Object System.Drawing.Rectangle(0, 0, $Bitmap.Width, $Bitmap.Height)
    $data = $Bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $stride = $data.Stride
        $bytes  = New-Object byte[] ($stride * $Bitmap.Height)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    } finally {
        $Bitmap.UnlockBits($data)
    }

    # GDI+ hands back premultiplied BGRA; ICO wants straight BGRA. Undo it.
    for ($i = 0; $i -lt $bytes.Length; $i += 4) {
        $alpha = $bytes[$i + 3]
        if ($alpha -eq 0) {
            $bytes[$i] = 0; $bytes[$i + 1] = 0; $bytes[$i + 2] = 0
        } elseif ($alpha -ne 255) {
            foreach ($channel in 0, 1, 2) {
                $value = [int] $bytes[$i + $channel] * 255
                $bytes[$i + $channel] = [byte] [Math]::Min(255, [int] (($value + $alpha / 2) / $alpha))
            }
        }
    }
    return ,$bytes
}

function ConvertTo-DibBytes {
    param(
        [System.Drawing.Bitmap] $Bitmap,
        [int] $Size
    )

    $bgra   = Get-BitmapBytes -Bitmap $Bitmap
    $stride = $Size * 4

    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)

    # BITMAPINFOHEADER: height counts the XOR image plus the AND mask.
    $writer.Write([uint32] 40)
    $writer.Write([int32]  $Size)
    $writer.Write([int32]  ($Size * 2))
    $writer.Write([uint16] 1)
    $writer.Write([uint16] 32)
    $writer.Write([uint32] 0)             # BI_RGB
    $writer.Write([uint32] ($stride * $Size))
    $writer.Write([int32]  0)             # pixels per metre
    $writer.Write([int32]  0)
    $writer.Write([uint32] 0)
    $writer.Write([uint32] 0)

    # XOR image, bottom row first.
    for ($y = $Size - 1; $y -ge 0; --$y) {
        $writer.Write($bgra, ($y * $stride), $stride)
    }

    # AND mask: all zero (the alpha channel already describes the shape).
    $maskStride = [int] ([Math]::Floor(($Size + 31) / 32) * 4)
    $maskRow    = New-Object byte[] $maskStride
    for ($y = 0; $y -lt $Size; ++$y) {
        $writer.Write($maskRow, 0, $maskStride)
    }

    $writer.Flush()
    $result = $stream.ToArray()
    $writer.Dispose()
    $stream.Dispose()
    return ,$result
}

function ConvertTo-PngBytes {
    param([System.Drawing.Bitmap] $Bitmap)

    $stream = New-Object System.IO.MemoryStream
    $Bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $result = $stream.ToArray()
    $stream.Dispose()
    return ,$result
}

# --- build every frame --------------------------------------------------------

$source = [System.Drawing.Image]::FromFile($SourcePath)
try {
    if ($CropToContent) {
        $sourceRect = Get-ContentBounds -Source $source -Threshold $CropAlphaThreshold
        Write-Host ("Artwork is {0}x{1}; content is {2}x{3} at {4},{5}" -f `
            $source.Width, $source.Height, $sourceRect.Width, $sourceRect.Height, $sourceRect.X, $sourceRect.Y)
    } else {
        $sourceRect = New-Object System.Drawing.Rectangle(0, 0, $source.Width, $source.Height)
    }

    $frames = @()
    foreach ($size in $sizes) {
        if (-not $SkipRedraw -and $size -le $redrawAtOrBelow) {
            $bitmap = Get-RedrawnBitmap -Size $size
        } else {
            $bitmap = Get-ScaledBitmap -Source $source -Size $size -SourceRect $sourceRect
        }
        try {
            if ($size -le 48) {
                $bytes = ConvertTo-DibBytes -Bitmap $bitmap -Size $size
            } else {
                $bytes = ConvertTo-PngBytes -Bitmap $bitmap
            }
            $frames += [pscustomobject]@{ Size = $size; Bytes = $bytes }
        } finally {
            $bitmap.Dispose()
        }
    }
} finally {
    $source.Dispose()
}

# --- assemble the .ico container ---------------------------------------------

$output = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($output)

$writer.Write([uint16] 0)                 # reserved
$writer.Write([uint16] 1)                 # type: icon
$writer.Write([uint16] $frames.Count)

$offset = 6 + 16 * $frames.Count
foreach ($frame in $frames) {
    $dimension = if ($frame.Size -ge 256) { 0 } else { $frame.Size }
    $writer.Write([byte]   $dimension)
    $writer.Write([byte]   $dimension)
    $writer.Write([byte]   0)             # palette size
    $writer.Write([byte]   0)             # reserved
    $writer.Write([uint16] 1)             # colour planes
    $writer.Write([uint16] 32)            # bits per pixel
    $writer.Write([uint32] $frame.Bytes.Length)
    $writer.Write([uint32] $offset)
    $offset += $frame.Bytes.Length
}
foreach ($frame in $frames) {
    $writer.Write($frame.Bytes, 0, $frame.Bytes.Length)
}

$writer.Flush()
$bytes = $output.ToArray()
$writer.Dispose()
$output.Dispose()

$directory = Split-Path -Parent $OutputPath
if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
[System.IO.File]::WriteAllBytes($OutputPath, $bytes)

# --- report -------------------------------------------------------------------

$icon = New-Object System.Drawing.Icon($OutputPath)
try {
    $described = ($sizes -join ', ')
    Write-Host ("Wrote {0} ({1} bytes, {2} frames: {3})" -f $OutputPath, $bytes.Length, $frames.Count, $described)
} finally {
    $icon.Dispose()
}
