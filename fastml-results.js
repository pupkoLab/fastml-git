(async () => {
  const $ = id => document.getElementById(id);
  const jobId = new URLSearchParams(location.search).get('job');
  if (!jobId) {
    $('status').textContent = 'No job selected. Please return to the input form.';
    return;
  }
  let job;
  try { job = await FastMLStore.load(jobId); }
  catch (error) { $('status').textContent = `Could not load results: ${error.message}`; return; }
  if (!job) {
    $('status').textContent = 'Job not found in this browser. Results are stored locally, not on GitHub Pages.';
    return;
  }

  const stages = [...(job.aligned === 'not-aligned' ? [['align','Kalign MSA']] : []),['unroot','Unroot tree'],['fastml','FastML'],['indel','IndelCoder'],['merge','Indel inference'],['done','Finished']];
  const labels = {
    'aligned.fasta':'Kalign multiple sequence alignment',
    'outTreeFileNewick.txt':'Reconstructed tree (Newick)',
    'outTreeFileAncestor.txt':'Ancestor-labeled tree',
    'outFile_prob_marginal.txt':'Marginal reconstruction probabilities',
    'outFile_seq_marginal.txt':'Marginal reconstructed sequences',
    'outFile_prob_joint.txt':'Joint reconstruction probabilities',
    'outFile_seq_joint.txt':'Joint reconstructed sequences',
    'reportFile.txt':'FastML report',
    'outFile_seq_marginal_no_indel.txt':'Marginal sequences before indel reconstruction',
    'outFile_seq_joint_no_indel.txt':'Joint sequences before indel reconstruction',
    'indelCoder.report':'IndelCoder report',
    'indelCoder.fasta':'Indel-coded binary alignment',
    'indel.nexus':'Indel coordinate table (NEXUS)',
    'indelcoder.log':'IndelCoder log',
    'indel_likelihood':'Ancestral indel likelihood and inferred states'
  };
  // These intermediate files remain in the saved job for debugging, but are
  // deliberately absent from the user-facing results table.
  const hiddenFiles = new Set([
    'pre.param','pre.params','param.file','indelcoder.param','unrooted_tree.txt',
    'indelCoder.report','indelCoder.fasta','indel.nexus','indelcoder.log',
    'indel_likelihood','outFile_seq_marginal_no_indel.txt',
    'outFile_seq_joint_no_indel.txt'
  ]);
  let worker = null;
  let objectUrls = [];

  $('download-results').addEventListener('click', () => {
    try {
      $('archive-error').textContent='';
      const blob=FastMLArchive.fromJob(job);
      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');
      const safeTitle=(job.jobTitle||'results').replace(/[^a-zA-Z0-9_.-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70)||'results';
      link.href=url;link.download=`fastml-${safeTitle}.zip`;link.click();
      setTimeout(()=>URL.revokeObjectURL(url),60000);
    } catch(error) { $('archive-error').textContent=`Could not create ZIP: ${error.message}`; }
  });

  function parseFasta(text) {
    const rows=[];let row=null;
    for (const line of text.split(/\r?\n/)) {
      if(line.startsWith('>')) {row={name:line.slice(1).trim(),seq:''};rows.push(row);}
      else if(line.trim()) {if(!row)throw new Error('Invalid FASTA input');row.seq+=line.trim();}
    }
    if(rows.length<2||rows.some(x=>!x.name||!x.seq))throw new Error('At least two valid FASTA sequences are required');
    return rows;
  }
  async function alignWithKalign(input) {
    if(typeof Aioli === 'undefined')throw new Error('Could not load the Kalign library from Biowasm');
    const original=parseFasta(input);
    const cli=await new Aioli(['kalign/3.3.1'],{printInterleaved:false});
    try {
      const dir=(await cli.pwd()).replace(/\/$/,'');
      await cli.mount([{name:'input.fasta',data:input+'\n'}]);
      const outputPath=dir+'/aligned.fasta';
      await cli.exec('kalign',['-i',dir+'/input.fasta','-o',outputPath,'--format','fasta']);
      const url=await cli.download(outputPath);
      const aligned=await (await fetch(url)).text();
      const rows=parseFasta(aligned);
      if(new Set(rows.map(x=>x.seq.length)).size!==1)throw new Error('Kalign returned sequences with unequal lengths');
      const originals=new Map(original.map(x=>[x.name,x.seq.replace(/-/g,'').toUpperCase()]));
      if(rows.length!==original.length||rows.some(x=>originals.get(x.name)!==x.seq.replace(/-/g,'').toUpperCase()))
        throw new Error('Kalign alignment failed input-sequence preservation check');
      return aligned;
    } finally {
      if(typeof cli.close==='function')await cli.close();
    }
  }

  function makeDownload(filename, content) {
    const url = URL.createObjectURL(new Blob([content], {type:'text/plain;charset=utf-8'}));
    objectUrls.push(url);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.textContent = 'here';
    return link;
  }
  function render() {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
    const done = job.status === 'completed';
    const failed = job.status === 'failed';
    $('state-label').textContent = done ? 'FINISHED' : failed ? 'FAILED' : 'RUNNING';
    $('status').className = `status ${done ? 'completed' : failed ? 'failed' : 'running'}`;
    $('status').textContent = job.message || (done ? 'All requested stages finished' : 'Preparing the analysis…');
    $('job-title').textContent = job.jobTitle || 'Untitled';
    $('alignment-name').textContent = job.alignmentName || 'Uploaded alignment';
    const mode = [job.model, job.branch, job.gamma ? `Gamma${job.alpha ? ` (α=${job.alpha})` : ''}` : '', job.joint ? 'Joint reconstruction enabled' : 'Marginal reconstruction'];
    $('running-mode').textContent = mode.filter(Boolean).join(' · ');
    const stageIndex = stages.findIndex(([key]) => key === job.stage);
    $('stages').replaceChildren(...stages.map(([key,label],index) => {
      const li = document.createElement('li');
      li.textContent = label;
      if (done || index < stageIndex) li.className = 'complete';
      else if (index === stageIndex && !failed) li.className = 'active';
      return li;
    }));

    const rows = [];
    for (const [filename,content] of Object.entries(job.outputs || {})) {
      if (hiddenFiles.has(filename) || typeof content !== 'string') continue;
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      nameCell.textContent = `${labels[filename] || filename} — ${filename}`;
      const downloadCell = document.createElement('td');
      downloadCell.appendChild(makeDownload(filename,content));
      row.append(nameCell,downloadCell);
      rows.push(row);
    }
    $('file-rows').replaceChildren(...rows);
    $('file-notice').hidden = rows.length > 0;
    if (!rows.length) $('file-notice').textContent = failed ? 'No result files were produced.' : 'Files will appear as processing stages finish.';
    $('indel-status').textContent = job.indels
      ? (job.indels.skipped ? 'Indel reconstruction skipped: input alignment contained no gaps.' : `Indel reconstruction completed (gain/loss rate ${job.indels.bestRate}).`)
      : '';
    // Keep rendering cheap: display only the tail; the full buffered log is downloadable.
    const log = job.log || '';
    $('run-log').textContent = log.slice(-5000) || 'No log messages yet.';
    const logLink = $('download-log');
    const logUrl = URL.createObjectURL(new Blob([log],{type:'text/plain;charset=utf-8'}));
    objectUrls.push(logUrl);
    logLink.href = logUrl;
  }

  render();
  if (job.status === 'completed' || job.status === 'failed') return;
  if (job.status === 'running') {
    job.message = 'Page reloaded: restarting computation from the beginning';
    job.outputs = job.alignmentCompleted ? {'aligned.fasta':job.msa} : {};
    job.log = '';
  }
  job.status = 'running';
  job.stage = job.aligned==='not-aligned'&&!job.alignmentCompleted?'align':'unroot';
  job.outputs ||= {};
  render();
  await FastMLStore.save(jobId,job);
  if(job.aligned==='not-aligned'&&!job.alignmentCompleted) {
    try {
      job.originalMsa ||= job.msa;
      job.message='Aligning unaligned FASTA using Kalign';
      render();
      const aligned=await alignWithKalign(job.msa);
      job.msa=aligned;
      job.alignmentCompleted=true;
      job.outputs['aligned.fasta']=aligned;
      job.stage='unroot';
      job.message='Alignment finished; starting tree unrooting';
      job.log=(job.log||'')+'[align] Kalign multiple sequence alignment completed\n';
      render();
      await FastMLStore.save(jobId,job);
    } catch(error) {
      job.status='failed';job.message=`Kalign alignment failed: ${error.message}`;
      render();await FastMLStore.save(jobId,job);return;
    }
  }
  try { worker = new Worker('fastml-worker.js'); }
  catch (error) {
    job.status = 'failed';
    job.message = `Cannot start worker: ${error.message}`;
    render();
    await FastMLStore.save(jobId,job);
    return;
  }
  let updateQueue = Promise.resolve();
  async function handle(message) {
    if (message.type === 'stage') {
      job.stage = message.stage;
      job.message = message.message;
      job.log = (job.log || '') + `[${message.stage}] ${message.message}\n`;
    } else if (message.type === 'files') {
      Object.assign(job.outputs, message.files);
      if (message.metadata) Object.assign(job,message.metadata);
    } else if (message.type === 'log') {
      job.log = (job.log || '') + message.text;
    } else if (message.type === 'done') {
      job.status = 'completed';
      job.stage = 'done';
      job.message = 'All requested stages finished';
      job.indels = message.indels;
      // Keep the submitted inputs so completed jobs can be exported as full ZIPs.
      worker?.terminate();
      worker = null;
    } else if (message.type === 'error') {
      job.status = 'failed';
      job.message = message.message;
      worker?.terminate();
      worker = null;
    }
    render();
    await FastMLStore.save(jobId,job);
  }
  worker.onmessage = event => {
    updateQueue = updateQueue.then(() => handle(event.data)).catch(error => {
      $('status').textContent = `Could not save job progress: ${error.message}`;
    });
  };
  worker.onerror = event => {
    updateQueue = updateQueue.then(() => handle({type:'error',message:event.message || 'Worker failed'}));
  };
  worker.postMessage({type:'start',job:{msa:job.msa,tree:job.tree,preParam:job.preParam,joint:job.joint}});
  window.addEventListener('pagehide', () => {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    worker?.terminate();
  });
})();
