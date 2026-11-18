const E=require('./engine.js'),KK=require('./kits.js'),sr=48000,fs=require('fs');
const K=KK['Studio kit (pop / rock)'],k=new E.Kit(sr);
K.pieces.forEach((pc,i)=>{const c=JSON.parse(JSON.stringify(pc.cfg));c.lite=true;const m=E.buildModel(c,sr);E.calibrate(m,sr);k.setPiece(i,m,{level:pc.level,pan:pc.pan});});
k.setMap(K.map);k.punch=K.mix.punch;if(k.mix)k.mix(K.mix);else Object.assign(k,{symp:K.mix.sympathy});
const bpm=96,s16=60/bpm/4,ev=[];let seed=7;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
const add=(step,n,v)=>ev.push([Math.round((step*s16+(rnd()-.5)*.006)*sr),n,Math.min(1,v*(0.93+rnd()*.1))]);
for(let bar=0;bar<8;bar++){const o=bar*16;
 if(bar===0)add(o,49,.9);
 for(let s=0;s<16;s+=2){ if(bar<4) add(o+s,42,s%4?.5:.72); else add(o+s,51,s%4?.55:.75);}
 if(bar===3)add(o+14,46,.7);
 [0,7,10].forEach(s=>add(o+s,36,s?.75:.9)); if(bar%2)add(o+13,36,.6);
 add(o+4,38,.9);add(o+12,38,.92); if(bar%2===0)add(o+15,38,.25);
 if(bar===7){[8,9,10,11].forEach(s=>add(o+s,48,.8));[12,13].forEach(s=>add(o+s,45,.85));[14,15].forEach(s=>add(o+s,41,.9));}
}
add(128,49,.95);add(128,36,.95);add(132,55,.8);
ev.sort((a,b)=>a[0]-b[0]);const N=Math.round((128*s16+4)*sr),L=new Float32Array(N),R=new Float32Array(N);let ei=0;
for(let b=0;b<N;b+=64){while(ei<ev.length&&ev[ei][0]<b+64){if(K.map[ev[ei][1]])k.noteOn(ev[ei][1],ev[ei][2]);ei++;}const n=Math.min(64,N-b);k.process(L.subarray(b,b+n),n,R.subarray(b,b+n));}
let pk=0;for(let i=0;i<N;i++)pk=Math.max(pk,Math.abs(L[i]),Math.abs(R[i]));const g=.89/pk;
const buf=Buffer.alloc(44+N*4);buf.write('RIFF',0);buf.writeUInt32LE(36+N*4,4);buf.write('WAVEfmt ',8);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(2,22);buf.writeUInt32LE(sr,24);buf.writeUInt32LE(sr*4,28);buf.writeUInt16LE(4,32);buf.writeUInt16LE(16,34);buf.write('data',36);buf.writeUInt32LE(N*4,40);
for(let i=0;i<N;i++){buf.writeInt16LE(Math.round(L[i]*g*32767),44+i*4);buf.writeInt16LE(Math.round(R[i]*g*32767),46+i*4);}
fs.writeFileSync('/home/claude/drum/studio_kit_groove.wav',buf);console.log('peak',pk.toFixed(3),'unused',ev.filter(e=>!K.map[e[1]]).map(e=>e[1]).filter((v,i,a)=>a.indexOf(v)===i));
