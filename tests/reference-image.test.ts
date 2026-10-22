import { readFile } from "node:fs/promises";
import { crc32, inflateSync } from "node:zlib";
import { expect, it } from "vitest";

it("合成参考PNGの全chunk・終端・赤色画素が壊れていない", async () => {
  const png = await readFile(
    new URL("./fixtures/reference-red.png", import.meta.url),
  );
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const chunks: Array<{ type: string; data: Buffer }> = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    expect(offset + 12 + length).toBeLessThanOrEqual(png.length);
    const body = png.subarray(offset + 4, offset + 8 + length);
    expect(crc32(body)).toBe(png.readUInt32BE(offset + 8 + length));
    chunks.push({ type: body.toString("ascii", 0, 4), data: body.subarray(4) });
    offset += 12 + length;
  }
  expect(offset).toBe(png.length);
  expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  expect(chunks[0].data.readUInt32BE(0)).toBe(64);
  expect(chunks[0].data.readUInt32BE(4)).toBe(64);
  expect([...chunks[0].data.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
  const pixels = inflateSync(chunks[1].data);
  expect(pixels.length).toBe(64 * 193);
  for (let y = 0; y < 64; y++) {
    expect(pixels[y * 193]).toBe(0);
    for (let x = 0; x < 64; x++) {
      expect([
        ...pixels.subarray(y * 193 + 1 + x * 3, y * 193 + 4 + x * 3),
      ]).toEqual([255, 0, 0]);
    }
  }
});
