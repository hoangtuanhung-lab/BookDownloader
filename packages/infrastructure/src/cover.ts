import sharp from "sharp";
import { AppError } from "../../contracts/src/index";
export async function normalizeCover(bytes: Uint8Array) {
  if (bytes.length > 5000000)
    throw new AppError("INPUT_TOO_LARGE", 413, "Ảnh tối đa 5 MB");
  const b = Buffer.from(bytes),
    jpeg = b[0] === 255 && b[1] === 216 && b[2] === 255,
    png = b
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    webp =
      b.subarray(0, 4).toString() === "RIFF" &&
      b.subarray(8, 12).toString() === "WEBP";
  if (!jpeg && !png && !webp)
    throw new AppError("INVALID_IMAGE", 400, "Chỉ nhận JPEG, PNG hoặc WebP");
  try {
    const image = sharp(b, {
        limitInputPixels: 20000000,
        animated: false,
        failOn: "error",
      }),
      meta = await image.metadata();
    if (!meta.width || !meta.height || (meta.pages || 1) > 1)
      throw Error("Invalid image");
    return await image
      .rotate()
      .resize({
        width: 1200,
        height: 1200,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw new AppError(
      "INVALID_IMAGE",
      400,
      "Ảnh lỗi hoặc vượt 20 triệu pixel",
    );
  }
}
