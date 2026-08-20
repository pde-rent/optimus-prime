---
name: attach-image
description: Load on-disk images (PNG, JPEG, GIF, WebP) into context as attachments you can actually SEE — screenshots, diagrams, charts, scans. `await attach_image.run(...paths)` -> a status string; throws on a non-image file or a model without vision. For pixel work use `Bun.Image`, which does not put the image in context.
---

# Attach Image

Load on-disk images into the model's context as multimodal attachments. The
image is sent to the model the same way a pasted image is, so the model can
actually look at it.

## When to use this

- The user points at an image file and wants you to look at it.
- You need to read text, a chart, a diagram, or a layout from an image.
- A screenshot needs visual interpretation.

## When NOT to use this

For *programmatic* work on an image — measuring pixels, cropping, resizing,
computing a hash, comparing files byte-by-byte — open it in the REPL with
`Bun.Image` instead:

```js
const img = new Bun.Image(await Bun.file("diagram.png").bytes());
const { width, height, format } = await img.metadata();
console.log(width, height, format);
await img.resize(320).webp().write("thumb.webp");
```

That path does not put the image in the model's context; it only lets you
compute over it. Use `attach_image.run` when you need to *see* the image.

## Usage

Call the prepared `attach_image` skill directly in the REPL:

```js
console.log(await attach_image.run("diagram.png"));
console.log(await attach_image.run("a.png", "b.jpg"));
```

The skill automatically resizes and compresses large images before loading them
into context. Animated images that need compression are flattened to their first
frame. Transparent images that need compression are composited onto a neutral
gray background. Extremely large images are rejected by pixel count before full
processing. The original file is left untouched.

Supported formats: PNG, JPEG, GIF, WebP. The skill errors if a file is not a
supported image, or if the current model is not vision-capable.
