#!/usr/bin/env node
import got from 'got';
import sharp from 'sharp';
import PromisePool from '@supercharge/promise-pool';
import yargs, { number } from 'yargs';
sharp.concurrency(1);
sharp.cache({ memory: 500, files: 100, items: 500 });

yargs
  .usage('Usage: -o outfile minlat minlon maxlat maxlon zoom http://whatever/{z}/{x}/{y}.png')
  .option('o', { alias: 'output', describe: 'Output file', type: 'string', demandOption: true })
  .option('t', { alias: 'tilesize', describe: 'Tile size', type: 'number', default: 256 })
  .command(
    '$0 <minlat> <minlon> <maxlat> <maxlon> <zoom> <url>',
    'Stitch tiles',
    () => {},
    (argv) => {
      stitch(
        argv.o as string,
        argv.minlat as number,
        argv.minlon as number,
        argv.maxlat as number,
        argv.maxlon as number,
        argv.zoom as number,
        argv.url as string,
        argv.tilesize as number
      );
    }
  ).argv;

async function stitch(filename: string, minlat: number, minlon: number, maxlat: number, maxlon: number, zoom: number, url: string, tilesize: number) {
  const { x: x1, y: y1 } = latlon2tile(maxlat, minlon, 32);
  const { x: x2, y: y2 } = latlon2tile(minlat, maxlon, 32);
  const tx1 = Math.floor(x1 / Math.pow(2, 32 - zoom));
  const ty1 = Math.floor(y1 / Math.pow(2, 32 - zoom));
  const tx2 = Math.floor(x2 / Math.pow(2, 32 - zoom));
  const ty2 = Math.floor(y2 / Math.pow(2, 32 - zoom));
  const tilesWidth = tx2 - tx1 + 1;
  const tilesHeight = ty2 - ty1 + 1;

  const { x: minx, y: miny } = projectlatlon(minlat, minlon);
  const { x: maxx, y: maxy } = projectlatlon(maxlat, maxlon);

  console.log(`==Geodetic Bounds  (EPSG:4236): ${minlat},${minlon} to ${maxlat},${maxlon}`);
  console.log(`==Projected Bounds (EPSG:3785): ${miny},${minx} to ${maxy},${maxx}`);
  console.log(`==Zoom Level: ${zoom}`);
  console.log(`==Upper Left Tile: x:${tx1} y:${ty2}`);
  console.log(`==Lower Right Tile: x:${tx2} y:${ty1}`);

  const xa = (((x1 / Math.pow(2, 32 - (zoom + 8))) & 0xff) * tilesize) / 256;
  const ya = (((y1 / Math.pow(2, 32 - (zoom + 8))) & 0xff) * tilesize) / 256;

  const width = Math.round(((x2 / Math.pow(2, 32 - (zoom + 8)) - x1 / Math.pow(2, 32 - (zoom + 8))) * tilesize) / 256);
  const height = Math.round(((y2 / Math.pow(2, 32 - (zoom + 8)) - y1 / Math.pow(2, 32 - (zoom + 8))) * tilesize) / 256);
  console.log(`==Raster Size: ${width}x${height}`);

  const px = (maxx - minx) / width;
  const py = Math.abs(maxy - miny) / height;
  console.log(`==Pixel Size: x:${px} y:${py}`);

  const images: Array<any> = [];
  const tiles: Array<[number, number]> = [];
  for (let ty = ty1; ty <= ty2; ty++) {
    for (let tx = tx1; tx <= tx2; tx++) {
      tiles.push([tx, ty]);
    }
  }
  let progress = 0;
  const { results, errors } = await PromisePool.withConcurrency(25)
    .for(tiles)
    .process(async ([tx, ty]) => {
      const xoff = (tx - tx1) * tilesize - xa;
      const yoff = (ty - ty1) * tilesize - ya;

      const fetchUrl = url
        .split('{z}')
        .join(zoom + '')
        .split('{x}')
        .join(tx + '')
        .split('{y}')
        .join(ty + '');
      const data = await got(fetchUrl);
      console.log(progress.toFixed(2) + '%');
      progress += 100 / tiles.length;
      if (data.statusCode === 200) {
        images.push({
          input: data.rawBody,
          top: yoff,
          left: xoff,
        });
      }
    });

  const newWidth = (tx2 - tx1 + 1) * tilesize;
  const newHeight = (ty2 - ty1 + 1) * tilesize;
  try {
    const tmpBuffer = await sharp({
      create: {
        width: newWidth,
        height: newHeight,
        channels: 4,
        background: 'rgba(0, 0, 0, 0)',
      },
      limitInputPixels: false,
      sequentialRead: true,
      failOnError: false,
    })
      .composite(images)
      .toBuffer();
    const output = await sharp(tmpBuffer, {
      raw: {
        width: newWidth,
        height: newHeight,
        channels: 4,
      },
      limitInputPixels: false,
    })
      .extract({ left: 0, top: 0, width: width, height: height })
      .toFile(filename);
    console.log('Success: ' + output);
  } catch (error) {
    console.error('Failed writing file');
  }
}

// http://wiki.openstreetmap.org/wiki/Slippy_map_tilenames
function latlon2tile(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const lat_rad = (lat * Math.PI) / 180;
  const n = 1 * Math.pow(2, zoom);

  const x = n * ((lon + 180) / 360);
  const y = (n * (1 - Math.log(Math.tan(lat_rad) + 1 / Math.cos(lat_rad)) / Math.PI)) / 2;
  return { x, y };
}

// Convert lat/lon in WGS84 to XY in Spherical Mercator (EPSG:900913/3857)
function projectlatlon(lat: number, lon: number): { x: number; y: number } {
  const originshift = 20037508.342789244; // 2 * pi * 6378137 / 2
  const x = (lon * originshift) / 180.0;
  let y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360.0)) / (Math.PI / 180.0);
  y = (y * originshift) / 180.0;
  return { x, y };
}
