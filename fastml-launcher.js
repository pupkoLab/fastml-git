/* Package the current job and the deployed Emscripten modules for Node.js. */
(function(root){
  'use strict';
  const required=[
    'fastml-node-runner.js','run-fastml.sh','run-fastml.bat','fastml-node-README.txt',
    'prepare-fastml.js','fastml-indels.js','fastml-archive.js',
    'tree_unroot.js','tree_unroot.wasm',
    'fastml.js','fastml.wasm',
    'indelCoder.js','indelCoder.wasm'
  ];
  async function build({msa,tree,preParam,aligned,joint,jobTitle='',onProgress=()=>{}}){
    const entries={
      'inputs/data.fas':msa,
      'inputs/tree.newick':tree,
      'pre.param':preParam,
      'launcher.json':JSON.stringify({aligned,joint,jobTitle},null,2)+'\n'
    };
    for(let i=0;i<required.length;i++){
      const filename=required[i];onProgress(`Downloading launcher assets (${i+1}/${required.length}): ${filename}`);
      const response=await fetch(new URL(filename,location.href),{cache:'no-cache'});
      if(!response.ok)throw new Error(`Cannot download ${filename}: HTTP ${response.status}`);
      entries[filename]=filename.endsWith('.wasm')?new Uint8Array(await response.arrayBuffer()):await response.text();
      if(filename==='run-fastml.bat')entries[filename]=entries[filename].replace(/\r?\n/g,'\r\n');
    }
    return root.FastMLArchive.zip(entries);
  }
  root.FastMLLauncher={build};
})(globalThis);
