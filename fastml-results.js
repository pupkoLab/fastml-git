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

  const stages = [['unroot','Unroot tree'],['fastml','FastML'],['indel','IndelCoder'],['merge','Indel inference'],['done','Finished']];
  const labels = {
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
    job.outputs = {};
    job.log = '';
  }
  job.status = 'running';
  job.stage = 'unroot';
  job.outputs ||= {};
  render();
  await FastMLStore.save(jobId,job);
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
      delete job.msa;
      delete job.tree;
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
