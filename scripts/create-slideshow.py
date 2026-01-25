from PIL import Image
from pathlib import Path

docs_images = Path(__file__).parent.parent / "docs" / "images"

images = [
    "famous-paintings.png",
    "mona-lisa.png",
    "extension.png"
]

FRAME_DURATION = 3000  # 3 seconds per frame in milliseconds

def create_slideshow():
    frames = []

    for img_name in images:
        img_path = docs_images / img_name
        img = Image.open(img_path)

        # Convert to RGB if needed (GIF doesn't support RGBA well)
        if img.mode == 'RGBA':
            background = Image.new('RGB', img.size, (13, 17, 23))  # GitHub dark bg
            background.paste(img, mask=img.split()[3])
            img = background
        elif img.mode != 'RGB':
            img = img.convert('RGB')

        frames.append(img)
        print(f"Processed: {img_name} ({img.width}x{img.height})")

    # Save as animated GIF
    output_path = docs_images / "slideshow.gif"
    frames[0].save(
        output_path,
        save_all=True,
        append_images=frames[1:],
        duration=FRAME_DURATION,
        loop=0  # 0 = infinite loop
    )

    print(f"\nSlideshow created: {output_path}")

if __name__ == "__main__":
    create_slideshow()
