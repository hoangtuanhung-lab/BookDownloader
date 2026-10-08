// Original deterministic metadata only; no downloaded content or real user IDs.
function syntheticLibrary({books=7,chaptersPerBook=9}={}) {
  const data={schemaVersion:1,provenance:'original synthetic test data; not the owner library',books:[],chapters:[],files:[]};
  const states=['ANALYZED','IDLE','READY','DOWNLOADING','PAUSED','ERROR','COMPLETED'];
  for(let b=0;b<books;b++) {
    const id='BOOK'+String(b+1).padStart(3,'0'),kind=b%3===1?'FILE':b%3===2?'FOLDER':'WEB';
    const status=kind==='FOLDER'?'COMPLETED':states[b%states.length];
    data.books.push([id,'Truyện mẫu '+b,kind==='WEB'?'https://fiction.test/book-'+b+'/':'',kind==='WEB'?'fiction.test':kind,'synthetic-folder-'+b,chaptersPerBook,0,0,status,'08/10/2026','Tác giả mẫu','Phiêu lưu',b%3===1?'Hồi':'Chương']);
    for(let c=0;c<chaptersPerBook;c++) {
      const state=kind==='FOLDER'?'DONE':c%5===0?'ERROR':c%5===1?'PENDING':'DONE';
      const skipped=state==='DONE' && c===3, fid=state==='DONE'&&!skipped?'synthetic-chapter-'+b+'-'+c:'';
      const order=c===4?4.5:c+1,group=c<5?'Quyển 1':'Quyển 2',display=c===2?'1-2':c%5+1;
      data.chapters.push([id,order,'Chương mẫu '+c,kind==='WEB'?'https://fiction.test/book-'+b+'/chuong-'+(c+1):'',state,fid,state==='ERROR'?1:0,state==='ERROR'?'NO_CONTENT: Mẫu lỗi':'','08/10/2026','Phần 1',group,display]);
      if(fid)data.files.push({id:fid,sizeBytes:1024+(b%10)*100+c%31});
    }
    const bookChapters=data.chapters.slice(-chaptersPerBook);
    data.books.at(-1)[6]=bookChapters.filter(c=>c[4]==='DONE').length;
    data.books.at(-1)[7]=bookChapters.filter(c=>c[4]==='ERROR').length;
  }
  return data;
}
module.exports={syntheticLibrary};
