/* Browser-side storage for generated FastML outputs. */
(function (root) {
  'use strict';
  function openDB() {
    return new Promise((resolve,reject) => {
      const req = indexedDB.open('fastml-browser-results',1);
      req.onupgradeneeded = () => req.result.createObjectStore('jobs');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function save(id,value) {
    const db = await openDB();
    try {
      await new Promise((resolve,reject) => {
        const tx = db.transaction('jobs','readwrite');
        tx.objectStore('jobs').put(value,id);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  async function load(id) {
    const db = await openDB();
    try {
      return await new Promise((resolve,reject) => {
        const req = db.transaction('jobs','readonly').objectStore('jobs').get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  }
  root.FastMLStore = {save,load};
})(globalThis);
