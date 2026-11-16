import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { locateLineDateCapsule } from '../src/extensions/line-date-capsule.mjs';
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let b=0;b<8;b++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(type,data){const body=Buffer.concat([Buffer.from(type),data]),result=Buffer.alloc(body.length+8);result.writeUInt32BE(data.length);body.copy(result,4);result.writeUInt32BE(crc32(body),result.length-4);return result;}
function image(kind){const width=250,height=40,rgba=Buffer.alloc((width*4+1)*height,255);
 for(let y=0;y<height;y++){rgba[y*(width*4+1)]=0;for(let x=0;x<width;x++){
   let on=false;
   if(kind==='rectangle')on=x>=85&&x<165&&y>=8&&y<32;
   if(kind==='capsule'||kind==='clipped'){
    const yy=kind==='clipped'?y+10:y;const cy=Math.max(16,Math.min(23,yy));
    const cx=Math.max(97,Math.min(152,x));on=(x-cx)**2+(yy-cy)**2<=12**2;
   }
   if(on){const offset=y*(width*4+1)+1+x*4;rgba.fill(240,offset,offset+3);}
 }}
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
 return {type:'image',mimeType:'image/png',data:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(rgba)),chunk('IEND',Buffer.alloc(0))]).toString('base64')};
}
test('actual System.Drawing detects complete centered capsule and rejects clipped, rectangle and empty crops',{skip:process.platform!=='win32'},async()=>{
 const options = { timeoutMs: 20_000 };
 assert.equal(await locateLineDateCapsule(image('capsule'), options),true);
 for(const kind of ['clipped','rectangle','empty'])assert.equal(await locateLineDateCapsule(image(kind), options),false,kind);
});
