/* Worker owning the entire FastML pipeline. The output page owns this worker
 * so navigating away from the input form does not terminate the computation.
 * Native stdout/stderr are buffered (not sent per line).
 */
'use strict';
importScripts('prepare-fastml.js','tree_unroot.js','fastml.js','indelCoder.js','fastml-indels.js');

let buffer='';
const LOG_BATCH_SIZE=64*1024;
function flushLog() {
  if(buffer) {postMessage({type:'log',text:buffer});buffer='';}
}
function capture(...values) {
  buffer+=values.join(' ')+'\n';
  if(buffer.length>=LOG_BATCH_SIZE)flushLog();
}
function stage(name,message) {
  flushLog();
  postMessage({type:'stage',stage:name,message});
}
function publish(files,metadata) {
  flushLog();
  postMessage({type:'files',files,metadata});
}
function moduleOptions() {
  return {print:capture,printErr:capture};
}
function getFile(mod,path) {return mod.FS.readFile(path,{encoding:'utf8'});}

async function processJob({msa,tree,preParam,joint}) {
  FastMLPrepare.validateFastMLOptions(preParam);
  stage('unroot','Loading tree unrooting WASM');
  const unroot=await createTreeUnrootModule(moduleOptions());
  unroot.FS.mkdir('/input');unroot.FS.mkdir('/results');
  unroot.FS.writeFile('/input/tree.txt',tree);
  unroot.callMain(['/input/tree.txt','/results/unrooted_tree.txt']);
  const unrootedTree=getFile(unroot,'/results/unrooted_tree.txt');
  if(!unrootedTree.trim())throw new Error('Unrooting produced an empty tree');
  const nativeParam=FastMLPrepare.prepareFastMLParams(preParam,{workDir:'/results'});
  publish({'unrooted_tree.txt':unrootedTree,'param.file':nativeParam});

  stage('fastml','Running FastML reconstruction');
  const fastml=await createFastMLModule(moduleOptions());
  fastml.FS.mkdir('/input');fastml.FS.mkdir('/results');
  fastml.FS.writeFile('/input/data.fas',msa);
  fastml.FS.writeFile('/results/unrooted_tree.txt',unrootedTree);
  fastml.FS.writeFile('/results/param.file',nativeParam);
  fastml.callMain(['/results/param.file']);
  const names=['outTreeFileNewick','outTreeFileAncestor','outFile_prob_marginal',
    'outFile_seq_marginal','reportFile'];
  if(joint)names.push('outFile_prob_joint','outFile_seq_joint');
  const outputs={};
  for(const name of names) {
    try{outputs[`${name}.txt`]=getFile(fastml,`/results/${name}.txt`);}
    catch {capture(`Missing output: ${name}.txt`);}
  }
  if(!outputs['outTreeFileNewick.txt']||!outputs['outFile_seq_marginal.txt'])
    throw new Error('FastML did not generate expected tree and marginal sequence files');
  publish(outputs);

  if(!msa.includes('-')) {
    stage('done','Finished; input MSA had no gaps, so indel reconstruction was skipped');
    postMessage({type:'done',indels:{skipped:true}});
    return;
  }

  stage('indel','Running indelCoder');
  const coder=await createIndelCoderModule(moduleOptions());
  coder.FS.mkdir('/input');coder.FS.mkdir('/results');
  coder.FS.writeFile('/input/data.fas',msa);
  const coderParam=[
    '_seqFile /input/data.fas',
    '_indelOutputInfoFile /results/indelCoder.report',
    '_indelOutputFastaFile /results/indelCoder.fasta',
    '_nexusFileName /results/indel.nexus',
    '_logFile /results/indelcoder.log',
    '_logValue 9','_codingType SIC','_isOmitLeadingAndEndingGaps 0'
  ].join('\n')+'\n';
  coder.FS.writeFile('/results/indelcoder.param',coderParam);
  coder.callMain(['/results/indelcoder.param']);
  const indelFiles={'indelcoder.param':coderParam};
  for(const name of ['indelCoder.report','indelCoder.fasta','indel.nexus','indelcoder.log'])
    indelFiles[name]=getFile(coder,`/results/${name}`);
  publish(indelFiles);

  stage('merge','Inferring ancestral indels and merging sequences');
  const inferred=FastMLIndels.inferIndels(outputs['outTreeFileNewick.txt'],indelFiles['indelCoder.fasta']);
  const merged={'indel_likelihood':inferred.report};
  const seqNames=['outFile_seq_marginal'];
  if(joint)seqNames.push('outFile_seq_joint');
  for(const name of seqNames) {
    const filename=`${name}.txt`;
    if(typeof outputs[filename]!=='string')throw new Error(`Missing reconstruction ${filename}`);
    merged[`${name}_no_indel.txt`]=outputs[filename];
    merged[filename]=FastMLIndels.combineResults(inferred,indelFiles['indel.nexus'],outputs[filename]);
  }
  publish(merged);
  stage('done','All reconstruction stages completed');
  postMessage({type:'done',indels:{skipped:false,bestRate:inferred.bestRate}});
}

self.onmessage=async event=>{
  if(event.data?.type!=='start')return;
  try {await processJob(event.data.job);flushLog();}
  catch(error) {
    capture(`ERROR: ${error.stack||error.message||String(error)}`);
    flushLog();
    postMessage({type:'error',message:error.message||String(error)});
  }
};
