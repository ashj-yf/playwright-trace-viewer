import sharp from 'sharp';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

const sizes = [16, 48, 128];
const svgBuffer = readFileSync(join(publicDir, 'icon.svg'));

// 16x16 简化版 — 保持小尺寸下的识别度
const svg16 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <rect x="0.5" y="0.5" width="15" height="15" rx="3.5" ry="3.5" fill="#2EAD33"/>
  <polygon points="6,4 6,12 11.5,8" fill="white"/>
  <polyline points="4,12.5 6.5,12.5 8,9.5" fill="none" stroke="white" stroke-width="1.2"
            stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

async function generate() {
  for (const size of sizes) {
    const svg = size === 16 ? svg16 : svgBuffer;
    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png()
      .toFile(join(publicDir, `icon-${size}.png`));
    console.log(`✅ icon-${size}.png`);
  }
}

generate().catch((err) => {
  console.error('❌ Failed:', err);
  process.exit(1);
});
