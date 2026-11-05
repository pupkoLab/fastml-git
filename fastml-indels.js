/* JavaScript port of the infer_indels() and combine_results() pipeline from
 * indel_ben.py / indel_coding.py. No ETE3 or NumPy dependency.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FastMLIndels = api;
})(globalThis, function () {
  'use strict';

  function readFasta(text) {
    const sequences = new Map();
    let name = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('>')) {
        name = line.slice(1).trim();
        if (!name || sequences.has(name)) throw new Error(`Invalid or duplicate FASTA name: ${name}`);
        sequences.set(name,'');
      } else {
        if (name === null) throw new Error('Expected FASTA header before sequence');
        sequences.set(name,sequences.get(name)+line);
      }
    }
    if (!sequences.size) throw new Error('FASTA is empty');
    const lengths = new Set(Array.from(sequences.values(),seq=>seq.length));
    if (lengths.size !== 1) throw new Error('Sequences must have identical lengths');
    return sequences;
  }

  function parseNewick(text) {
    const src = text.trim();
    let pos = 0;
    function whitespace() { while (/\s/.test(src[pos]||'') && pos<src.length) pos++; }
    function label() {
      whitespace();
      if (src[pos] === "'") {
        pos++;let result='';
        while(pos<src.length) {
          if(src[pos] === "'") { pos++;if(src[pos] === "'") {result+="'";pos++;} else break; }
          else result+=src[pos++];
        }
        return result;
      }
      const start=pos;
      while(pos<src.length && !/[(),:;\s]/.test(src[pos]))pos++;
      return src.slice(start,pos);
    }
    function subtree(parent) {
      whitespace();
      const node={name:'',distance:0,children:[],parent,p0:0,p1:0};
      if(src[pos] === '(') {
        pos++;
        do {
          node.children.push(subtree(node));
          whitespace();
          if(src[pos]!==',')break;
          pos++;
        } while(true);
        if(src[pos]!==')')throw new Error(`Malformed Newick near ${pos}: expected ')'`);
        pos++;
      }
      node.name=label();
      whitespace();
      if(src[pos] === ':') {
        pos++;
        const value=label();
        node.distance=Number(value);
        if(!value || !Number.isFinite(node.distance)||node.distance<0)throw new Error(`Invalid branch length: ${value}`);
      }
      return node;
    }
    const tree=subtree(null);
    whitespace();if(src[pos++]!==';'||src.slice(pos).trim())throw new Error('Expected a single Newick tree ending with ;');
    // ETE3 names unnamed nodes from descendant names when the root is unnamed.
    if(!tree.name) {
      function nameMissing(node) {
        for(const c of node.children)nameMissing(c);
        if(!node.name)node.name=`{${node.children.map(c=>c.name).join('')}}`;
      }
      nameMissing(tree);
    }
    return tree;
  }

  function traverse(tree) {
    const result=[];
    (function visit(n){result.push(n);for(const c of n.children)visit(c);})(tree);
    return result;
  }
  function postorder(tree) {
    const result=[];
    (function visit(n){for(const c of n.children)visit(c);result.push(n);})(tree);
    return result;
  }
  function transition(gl,t) {
    // Equal gain and loss rates: pi0=pi1=0.5.
    const e=Math.exp(-2*gl*t);
    return {same:(1+e)/2,change:(1-e)/2};
  }
  function initializeLeaves(tree, binaryFasta, position) {
    const leaves=traverse(tree).filter(n=>!n.children.length);
    for(const node of leaves) {
      const sequence=binaryFasta.get(node.name);
      if(!sequence)throw new Error(`Indel-coding FASTA lacks tree leaf '${node.name}'`);
      const state=sequence[position];
      if(state==='0'){node.p0=1;node.p1=0;}
      else if(state==='1'){node.p0=0;node.p1=1;}
      else if(state==='?'){node.p0=1;node.p1=1;}
      else throw new Error(`Unexpected indel state '${state}' for ${node.name}`);
    }
  }
  function upward(tree,rate) {
    for(const node of postorder(tree)) {
      if(!node.children.length)continue;
      node.p0=1;node.p1=1;
      for(const child of node.children) {
        const m=transition(rate,child.distance);
        const x0=m.same*child.p0+m.change*child.p1;
        const x1=m.change*child.p0+m.same*child.p1;
        node.p0*=x0;node.p1*=x1;
      }
    }
  }
  function downward(tree,rate) {
    tree.down0=1;tree.down1=1;
    for(const parent of traverse(tree))for(const child of parent.children) {
      let bros0=1,bros1=1;
      for(const sibling of parent.children)if(sibling!==child) {
        const m=transition(rate,sibling.distance);
        bros0*=m.same*sibling.p0+m.change*sibling.p1;
        bros1*=m.change*sibling.p0+m.same*sibling.p1;
      }
      if(parent===tree){child.down0=bros0;child.down1=bros1;}
      else {
        const m=transition(rate,parent.distance);
        child.down0=(m.same*parent.down0+m.change*parent.down1)*bros0;
        child.down1=(m.change*parent.down0+m.same*parent.down1)*bros1;
      }
    }
  }
  function marginal(tree,rate,pi0) {
    for(const node of traverse(tree)) {
      if(node===tree){node.m0=node.p0;node.m1=node.p1;}
      else {
        const m=transition(rate,node.distance);
        node.m0=pi0*node.p0*(node.down0*m.same+node.down1*m.change);
        node.m1=(1-pi0)*node.p1*(node.down0*m.change+node.down1*m.same);
      }
    }
  }
  function inferIndels(treeText, indelFastaText, pi0=0.5) {
    if(pi0!==0.5)throw new Error('This port currently supports the Python default pi0=0.5');
    const tree=parseNewick(treeText);
    const states=readFasta(indelFastaText);
    const length=states.values().next().value.length;
    const nodes=traverse(tree);
    if(new Set(nodes.map(n=>n.name)).size!==nodes.length)throw new Error('Tree node names must be unique for indel merging');
    const likelihoods=[];
    let bestRate=0.05,bestScore=-Infinity;
    for(let j=1;j<=20;j++) {
      const rate=j*0.05;
      let logLikelihood=0;
      for(let i=0;i<length;i++) {
        initializeLeaves(tree,states,i);
        upward(tree,rate);
        const likelihood=(tree.p0+tree.p1)/2;
        logLikelihood+=likelihood>0?Math.log10(likelihood):-Infinity;
      }
      likelihoods.push({rate,logLikelihood});
      if(logLikelihood>bestScore){bestScore=logLikelihood;bestRate=rate;}
    }
    const sequences=new Map(nodes.map(n=>[n.name,[]]));
    for(let i=0;i<length;i++) {
      initializeLeaves(tree,states,i);
      upward(tree,bestRate);
      downward(tree,bestRate);
      marginal(tree,bestRate,pi0);
      for(const node of nodes) sequences.get(node.name).push(node.m0>=node.m1?0:1);
    }
    const report=[`pi_0 = ${pi0}\tpi_1 = ${1-pi0}`,
      `max g = max l = ${bestRate}`,`tree log-likelihood = ${bestScore}`,
      ...Array.from(sequences,([name,seq])=>`${name}\n${seq.join('')}`)].join('\n')+'\n';
    return {sequences,bestRate,bestScore,likelihoods,report};
  }

  function parseNexusRanges(text) {
    const lines=text.split(/\r?\n/);
    const marker=lines.findIndex(s=>s.includes('No.\textension'));
    if(marker<0)throw new Error('Cannot find No. extension table in indel.nexus');
    const ranges=[];
    for(let i=marker+1;i<lines.length;i++) {
      const line=lines[i].trim();
      if(line.includes(']'))break;
      if(!line)continue;
      const match=line.match(/^\S+\s+(\d+)-(\d+)/);
      if(!match)throw new Error(`Unexpected indel NEXUS coordinate: ${line}`);
      const start=Number(match[1])-1,end=Number(match[2]);
      if(start<0||end<=start)throw new Error(`Invalid indel coordinates: ${line}`);
      ranges.push([start,end]);
    }
    return ranges;
  }

  function combineResults(inferred,nexusText,fastmlFastaText) {
    const ranges=parseNexusRanges(nexusText);
    const sequences=readFasta(fastmlFastaText);
    const result=[];
    for(const [name,sequence] of sequences) {
      const binary=inferred.sequences.get(name);
      if(!binary)throw new Error(`Indel reconstruction lacks FastML node '${name}'`);
      if(binary.length!==ranges.length)throw new Error(`Indel state/coordinate count mismatch for ${name}`);
      const chars=Array.from(sequence);
      for(let i=0;i<binary.length;i++)if(binary[i]===1) {
        const [start,end]=ranges[i];
        if(end>chars.length)throw new Error(`Indel range exceeds sequence length for ${name}`);
        chars.fill('-',start,end);
      }
      result.push(`>${name}\n${chars.join('')}`);
    }
    return result.join('\n')+'\n';
  }

  return {readFasta,parseNewick,parseNexusRanges,inferIndels,combineResults};
});
