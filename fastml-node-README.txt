FastML Node Launcher
====================

This ZIP contains your inputs, native FastML parameters, all three compiled
WebAssembly modules, and the JavaScript reconstruction/indel pipeline.

Requirements:
  - Node.js 18 or newer.
  - For unaligned nucleotide or amino-acid FASTA, Kalign must be installed
    separately and accessible from your PATH.

Linux/macOS:
  Extract the ZIP, open a terminal in its folder, and run:
    bash run-fastml.sh

Windows:
  Extract the ZIP, then double-click run-fastml.bat or run it from cmd.exe.

Results are written to the results/ folder.
Execution output and errors are saved to fastml-run.log.
After a successful run, results.zip is created in this folder.
Upload results.zip using "Upload previous results" on the FastML GitHub
Pages home page to view the results in results.html.

The input FASTA, Newick tree, and pre.param are included in the ZIP. If you
edit those files after extracting, rerun the script to recalculate results.

Note: The Node runtime has not been tested with every compiled WASM module.
