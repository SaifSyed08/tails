"""Builds the GitHub social preview card.

1280x640, which is what GitHub asks for, and it gets shown at roughly a third
of that in a link unfurl. Everything here is sized for the small version: if a
line is not readable at 440px wide it does not belong on the card.

The composition is the pitch. Three panels of the same app wearing three
generated themes says "this thing restyles itself" before anyone reads a word,
so the art carries the claim and the text only has to name the product.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 640
FONTS = Path('C:/Windows/Fonts')
INK = (243, 243, 245)
DIM = (163, 163, 173)
AMBER = (245, 158, 11)

def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), size)

def thumb(path: str, width: int, height: int, radius: int = 10) -> Image.Image:
    """A whole window, shrunk, with rounded corners and a hairline edge.

    The whole window rather than a crop of it. Zoomed into the transcript these
    read as three walls of unreadable text; at window scale the sidebar, the
    bubbles and the accent all land, and three of them side by side read as the
    same app three times.
    """
    im = Image.open(path).convert('RGB')
    scale = max(width / im.width, height / im.height)
    im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    im = im.crop((0, 0, width, height))

    mask = Image.new('L', (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, width - 1, height - 1], radius, fill=255)
    card = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    card.paste(im, (0, 0), mask)
    ImageDraw.Draw(card).rounded_rectangle(
        [0, 0, width - 1, height - 1], radius, outline=(255, 255, 255, 38), width=2)
    return card

def build(out: Path) -> None:
    card = Image.new('RGB', (W, H), (11, 11, 14))
    draw = ImageDraw.Draw(card)

    # The artwork and the words get their own halves of the card. Overlaying
    # text on three screenshots at once means it has to survive both a black
    # theme and a cream one, and the version that tried it was unreadable on
    # the cream.
    shots = ['shots/theme-amber.png', 'themes/theme-2.png', 'shots/theme-neon.png']
    gap, margin = 18, 40
    tw = (W - margin * 2 - gap * 2) // 3
    th = round(tw * 0.625)
    for i, shot in enumerate(shots):
        tile = thumb(shot, tw, th)
        card.paste(tile, (margin + i * (tw + gap), 56), tile)

    title = font('segoeuib.ttf', 92)
    lead = font('segoeui.ttf', 33)
    small = font('consolab.ttf', 22)

    x = margin + 4
    # Chosen so the whole block sits centred: content runs 56..574 in a 640
    # card, which leaves matching air above the thumbnails and below the text.
    y = 340

    draw.rectangle([x, y, x + 74, y + 5], fill=AMBER)
    draw.text((x, y + 26), 'T.A.I.L.S.', font=title, fill=INK)

    ly = y + 160
    draw.text((x, ly), 'Claude Code UI', font=lead, fill=AMBER)
    span = draw.textlength('Claude Code UI', font=lead)
    draw.text((x + span, ly), '   the CLI, with a UI personalized to you',
              font=lead, fill=DIM)

    draw.text((x, ly + 50),
              'generative themes  ·  local models  ·  voice  ·  pets',
              font=small, fill=(122, 122, 134))

    # The pets, filling the space to the right of the wordmark rather than
    # being crammed under it. They are the one feature the three thumbnails
    # cannot show, and the card had a hole exactly their shape.
    lineup = Image.open('sprites/lineup.png').convert('RGBA')
    lw = 430
    lineup = lineup.resize((lw, round(lineup.height * lw / lineup.width)), Image.LANCZOS)
    card.paste(lineup, (W - margin - lw, y + 34), lineup)

    out.parent.mkdir(parents=True, exist_ok=True)
    card.save(out, optimize=True)
    print(f'{out.name}  {card.size[0]}x{card.size[1]}  {out.stat().st_size // 1024} KB')

if __name__ == '__main__':
    build(Path('social-preview.png'))
