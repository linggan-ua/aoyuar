#!/usr/bin/env python3
"""按 AR.js 生成器的几何把「内图」拼成可直接打印的标准 marker 图。

几何（对应 arjs 的 patternRatio: 0.5，必须严格一致，否则识别不到）：
    整图          白边 10% + 黑方块 80%
    黑方块内部    内图居中，占黑方块的 50%（= 整图的 40%）

用法: python3 tools/build-marker.py <内图> <输出.png> [输出边长，默认 2000]
"""
import struct
import sys
import zlib


def load_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', '不是 PNG: ' + path
    pos, idat, pal = 8, b'', None
    w = h = bitdepth = colortype = None
    while pos < len(data):
        ln, typ = struct.unpack('>I4s', data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b'IHDR':
            w, h, bitdepth, colortype, _, _, inter = struct.unpack('>IIBBBBB', chunk)
            assert bitdepth == 8 and inter == 0, '只支持 8bit 非隔行 PNG'
        elif typ == b'PLTE':
            pal = chunk
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'IEND':
            break
    raw = zlib.decompress(idat)
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colortype]
    stride = w * ch
    rows, prev, p = [], bytearray(stride), 0
    for y in range(h):
        ft = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if ft == 1:
            for i in range(ch, stride): line[i] = (line[i] + line[i - ch]) & 255
        elif ft == 2:
            for i in range(stride): line[i] = (line[i] + prev[i]) & 255
        elif ft == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif ft == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]; c = prev[i - ch] if i >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        row = []
        for x in range(w):
            if colortype in (2, 6): row.append((line[x * ch], line[x * ch + 1], line[x * ch + 2]))
            elif colortype in (0, 4): v = line[x * ch]; row.append((v, v, v))
            else:
                i = line[x] * 3; row.append((pal[i], pal[i + 1], pal[i + 2]))
        rows.append(row); prev = line
    return w, h, rows


def write_png(path, w, h, rows):
    raw = b''.join(b'\x00' + bytes(v for px in row for v in px) for row in rows)
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 6))
        + chunk(b'IEND', b''))


def build(inner_path, out_path, size=2000):
    w, h, img = load_png(inner_path)
    white = round(size * 0.10)          # 白边
    square = round(size * 0.80)         # 黑方块
    inner = round(square * 0.50)        # 内图占黑方块的 50%
    x0 = white + (square - inner) // 2
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            in_black = white <= x < white + square and white <= y < white + square
            in_inner = x0 <= x < x0 + inner and x0 <= y < x0 + inner
            if in_inner:
                sx = int((x - x0) * w / inner)
                sy = int((y - x0) * h / inner)
                row.append(img[min(sy, h - 1)][min(sx, w - 1)])
            elif in_black:
                row.append((0, 0, 0))
            else:
                row.append((255, 255, 255))
        out.append(row)
    write_png(out_path, size, size, out)
    print('%s：整图 %d，白边 %d，黑方块 %d，内图 %d（内图占黑方块 %.2f）' %
          (out_path.split('/')[-1], size, white, square, inner, inner / square))


if __name__ == '__main__':
    build(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 2000)
