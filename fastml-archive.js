/* Dependency-free ZIP export/import for FastML browser results.
 * Exports ZIP STORE entries; imports STORE and DEFLATE entries in browsers
 * supporting DecompressionStream('deflate-raw'). No files are executed.
 */
(function(root){
  'use strict';
  const enc=new TextEncoder(),dec=new TextDecoder();
  const MAX_ZIP=100*1024*1024,MAX_FILE=300*1024*1024;
  const table=Uint32Array.from({length:256},(_,n)=>{
    for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;
    return n>>>0;
  });
  function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
  function put16(view,at,n){view.setUint16(at,n,true);}
  function put32(view,at,n){view.setUint32(at,n,true);}
  function zip(entries){
    const chunks=[],central=[];let offset=0;
    for(const [name,content] of Object.entries(entries)){
      if(!/^[a-zA-Z0-9_.\/-]+$/.test(name)||name.includes('..')||name.startsWith('/'))throw Error('Invalid archive filename');
      const filename=enc.encode(name),data=typeof content==='string'?enc.encode(content):content;
      if(!(data instanceof Uint8Array)||data.length>MAX_FILE)throw Error('Invalid archive content');
      const crc=crc32(data),local=new Uint8Array(30+filename.length),lv=new DataView(local.buffer);
      put32(lv,0,0x04034b50);put16(lv,4,20);put16(lv,6,0x800);put16(lv,8,0);
      put32(lv,14,crc);put32(lv,18,data.length);put32(lv,22,data.length);
      put16(lv,26,filename.length);local.set(filename,30);
      chunks.push(local,data);
      const cd=new Uint8Array(46+filename.length),cv=new DataView(cd.buffer);
      put32(cv,0,0x02014b50);put16(cv,4,20);put16(cv,6,20);put16(cv,8,0x800);
      put32(cv,16,crc);put32(cv,20,data.length);put32(cv,24,data.length);
      put16(cv,28,filename.length);put32(cv,42,offset);cd.set(filename,46);
      central.push(cd);offset+=local.length+data.length;
    }
    if(central.length>65535)throw Error('Too many files for a ZIP archive');
    const centralOffset=offset,centralSize=central.reduce((n,b)=>n+b.length,0);
    const end=new Uint8Array(22),ev=new DataView(end.buffer);
    put32(ev,0,0x06054b50);put16(ev,8,central.length);put16(ev,10,central.length);
    put32(ev,12,centralSize);put32(ev,16,centralOffset);
    return new Blob([...chunks,...central,end],{type:'application/zip'});
  }
  async function unzip(file){
    if(file.size>MAX_ZIP)throw Error('ZIP exceeds the 100 MB import limit');
    const bytes=new Uint8Array(await file.arrayBuffer()),v=new DataView(bytes.buffer);
    let end=-1;
    for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){if(v.getUint32(i,true)===0x06054b50){end=i;break;}}
    if(end<0)throw Error('Invalid ZIP: missing central directory');
    const count=v.getUint16(end+10,true),size=v.getUint32(end+12,true),start=v.getUint32(end+16,true);
    if(start+size>bytes.length||count>300)throw Error('Invalid or oversized ZIP directory');
    let at=start,total=0;const files={};
    for(let i=0;i<count;i++){
      if(at+46>bytes.length||v.getUint32(at,true)!==0x02014b50)throw Error('Invalid ZIP entry');
      const flags=v.getUint16(at+8,true),method=v.getUint16(at+10,true);
      const expectedCrc=v.getUint32(at+16,true),packed=v.getUint32(at+20,true),unpacked=v.getUint32(at+24,true);
      const nameLen=v.getUint16(at+28,true),extra=v.getUint16(at+30,true),comment=v.getUint16(at+32,true),localAt=v.getUint32(at+42,true);
      if(flags&1||unpacked>MAX_FILE||(total+=unpacked)>MAX_ZIP)throw Error('Encrypted or oversized ZIP entry');
      if(at+46+nameLen+extra+comment>bytes.length)throw Error('Truncated ZIP entry');
      const name=dec.decode(bytes.subarray(at+46,at+46+nameLen));
      if(!/^[a-zA-Z0-9_.\/-]+$/.test(name)||name.includes('..')||name.startsWith('/')||Object.hasOwn(files,name))throw Error('Unsafe or duplicate ZIP filename');
      if(localAt+30>bytes.length||v.getUint32(localAt,true)!==0x04034b50)throw Error('Invalid ZIP local header');
      const dataAt=localAt+30+v.getUint16(localAt+26,true)+v.getUint16(localAt+28,true);
      if(dataAt+packed>bytes.length)throw Error('Truncated ZIP data');
      const raw=bytes.subarray(dataAt,dataAt+packed);
      let result;
      if(method===0)result=raw;
      else if(method===8){
        if(typeof DecompressionStream==='undefined')throw Error('This browser cannot decompress ZIP files');
        const stream=new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        result=new Uint8Array(await new Response(stream).arrayBuffer());
      }else throw Error('Unsupported ZIP compression method');
      if(result.length!==unpacked||crc32(result)!==expectedCrc)throw Error(`Corrupt archive entry: ${name}`);
      files[name]=dec.decode(result);at+=46+nameLen+extra+comment;
    }
    return files;
  }
  function fromJob(job){
    const entries={};
    const metadata={format:'fastml-browser-results',version:1,jobTitle:job.jobTitle||'',model:job.model||'',aligned:job.aligned||'aligned',joint:!!job.joint,branch:job.branch||'',gamma:job.gamma||'',alpha:job.alpha||'',status:job.status||'completed',message:job.message||'',alignmentName:job.alignmentName||'',startedAt:job.startedAt||null,indels:job.indels||null};
    entries['manifest.json']=JSON.stringify(metadata,null,2)+'\n';
    const original=job.originalMsa||job.msa;
    if(typeof original==='string')entries['inputs/sequences.fasta']=original;
    if(typeof job.tree==='string')entries['inputs/tree.newick']=job.tree;
    if(typeof job.preParam==='string')entries['parameters/pre.param']=job.preParam;
    for(const [name,value] of Object.entries(job.outputs||{})){
      if(typeof value==='string'&&/^[a-zA-Z0-9_.-]+$/.test(name))entries[`outputs/${name}`]=value;
    }
    if(typeof job.log==='string')entries['run.log']=job.log;
    return zip(entries);
  }
  async function importJob(file){
    const files=await unzip(file);
    if(!files['manifest.json'])throw Error('Not a FastML results archive: missing manifest.json');
    let meta;try{meta=JSON.parse(files['manifest.json']);}catch{throw Error('Invalid FastML archive manifest');}
    if(meta.format!=='fastml-browser-results'||meta.version!==1)throw Error('Unsupported FastML archive format');
    const outputs={};for(const [name,content]of Object.entries(files))if(name.startsWith('outputs/'))outputs[name.slice(8)]=content;
    return {jobTitle:String(meta.jobTitle||''),model:String(meta.model||''),aligned:meta.aligned||'aligned',joint:!!meta.joint,branch:meta.branch||'',gamma:meta.gamma||'',alpha:meta.alpha||'',alignmentName:meta.alignmentName||'Imported FASTA',startedAt:meta.startedAt||Date.now(),indels:meta.indels||null,msa:files['inputs/sequences.fasta'],originalMsa:files['inputs/sequences.fasta'],tree:files['inputs/tree.newick'],preParam:files['parameters/pre.param'],outputs,log:files['run.log']||'',status:'completed',stage:'done',message:'Imported previous FastML results'};
  }
  root.FastMLArchive={fromJob,importJob,zip,unzip};
})(globalThis);
