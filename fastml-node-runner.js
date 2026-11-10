#!/usr/bin/env node
/* FastML Node launcher, packaged with all WASM modules and input files. */
'use strict';
const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');
const root=__dirname;
const input=path.join(root,'inputs');
const output=path.join(root,'results');
const config=JSON.parse(fs.readFileSync(path.join(root,'launcher.json'),'utf8'));
const prepare=require('./prepare-fastml.js');
const indels=require('./fastml-indels.js');
let nativeLog='',nativeLogBytes=0;
function flushNativeLog(){if(nativeLog){process.stdout.write(nativeLog);nativeLog='';nativeLogBytes=0;}}
function captureNativeLog(...values){const line=values.join(' ')+'\n';nativeLog+=line;nativeLogBytes+=line.length;if(nativeLogBytes>=64*1024)flushNativeLog();}
const moduleOptions={locateFile:name=>path.join(root,name),print:captureNativeLog,printErr:captureNativeLog};
function stage(label){flushNativeLog();console.log(`[${new Date().toISOString()}] ${label}`);}
function read(mod,name){return mod.FS.readFile(`/results/${name}`,{encoding:'utf8'});}
function save(mod,name){
  const content=read(mod,name);
  fs.writeFileSync(path.join(output,name),content);
  return content;
}
async function main(){
  fs.mkdirSync(output,{recursive:true});
  let msa=fs.readFileSync(path.join(input,'data.fas'),'utf8');
  const tree=fs.readFileSync(path.join(input,'tree.newick'),'utf8');
  const preParam=fs.readFileSync(path.join(root,'pre.param'),'utf8');
  prepare.validateFastMLOptions(preParam);
  if(config.aligned==='not-aligned'){
    stage('Aligning input sequences with external Kalign');
    const alignedPath=path.join(output,'aligned.fasta');
    const result=spawnSync('kalign',['-i',path.join(input,'data.fas'),'-o',alignedPath,'--format','fasta'],{encoding:'utf8'});
    if(result.error)throw new Error('Kalign is required for unaligned input. Install Kalign and put it on PATH. '+result.error.message);
    if(result.status!==0)throw new Error('Kalign failed: '+(result.stderr||result.stdout||result.status));
    msa=fs.readFileSync(alignedPath,'utf8');
  }

  stage('Unrooting tree');
  const unroot=await require('./tree_unroot.js')(moduleOptions);
  unroot.FS.mkdir('/input');unroot.FS.mkdir('/results');
  unroot.FS.writeFile('/input/tree.txt',tree);
  unroot.callMain(['/input/tree.txt','/results/unrooted_tree.txt']);
  const unrooted=read(unroot,'unrooted_tree.txt');
  fs.writeFileSync(path.join(output,'unrooted_tree.txt'),unrooted);

  stage('FastML reconstruction');
  const nativeParam=prepare.prepareFastMLParams(preParam,{workDir:'/results',msaPath:'/input/data.fas'});
  fs.writeFileSync(path.join(output,'param.file'),nativeParam);
  const fastml=await require('./fastml.js')(moduleOptions);
  fastml.FS.mkdir('/input');fastml.FS.mkdir('/results');
  fastml.FS.writeFile('/input/data.fas',msa);
  fastml.FS.writeFile('/results/unrooted_tree.txt',unrooted);
  fastml.FS.writeFile('/results/param.file',nativeParam);
  fastml.callMain(['/results/param.file']);
  const names=['outTreeFileNewick.txt','outTreeFileAncestor.txt','outFile_prob_marginal.txt','outFile_seq_marginal.txt','reportFile.txt'];
  if(config.joint)names.push('outFile_prob_joint.txt','outFile_seq_joint.txt');
  const outputs={};
  for(const name of names)outputs[name]=save(fastml,name);
  if(!msa.includes('-')){stage('Finished (no alignment gaps; indel reconstruction skipped)');return;}

  stage('Running IndelCoder');
  const coder=await require('./indelCoder.js')(moduleOptions);
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
  fs.writeFileSync(path.join(output,'indelcoder.param'),coderParam);
  coder.callMain(['/results/indelcoder.param']);
  for(const name of ['indelCoder.report','indelCoder.fasta','indel.nexus','indelcoder.log'])save(coder,name);

  stage('Inferring ancestral indels and merging reconstructions');
  const inferred=indels.inferIndels(outputs['outTreeFileNewick.txt'],fs.readFileSync(path.join(output,'indelCoder.fasta'),'utf8'));
  fs.writeFileSync(path.join(output,'indel_likelihood'),inferred.report);
  const nexus=fs.readFileSync(path.join(output,'indel.nexus'),'utf8');
  for(const name of ['outFile_seq_marginal.txt',...(config.joint?['outFile_seq_joint.txt']:[])]){
    fs.writeFileSync(path.join(output,name.replace('.txt','_no_indel.txt')),outputs[name]);
    fs.writeFileSync(path.join(output,name),indels.combineResults(inferred,nexus,outputs[name]));
  }
  stage('Finished');
}
main().then(flushNativeLog).catch(error=>{flushNativeLog();console.error(error.stack||error);process.exitCode=1;});
