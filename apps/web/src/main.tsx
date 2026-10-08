import React, {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {HealthResponse} from '../../../packages/contracts/src/index';
import './styles.css';
const routes=[{path:'/read',icon:'📖',title:'Đọc truyện',phase:6},{path:'/download',icon:'⬇️',title:'Tải sách',phase:4},{path:'/manage',icon:'📚',title:'Quản lý sách',phase:5},{path:'/admin',icon:'⚙️',title:'Quản trị',phase:2}];
function App() {
 const [path,setPath]=useState(window.location.pathname),[collapsed,collapse]=useState(false),[help,showHelp]=useState(false),[notice,setNotice]=useState(''),[health,setHealth]=useState('Chưa kiểm tra');
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const fn=()=>setPath(window.location.pathname);window.addEventListener('popstate',fn);return()=>window.removeEventListener('popstate',fn);},[]);
 useEffect(()=>{if(help)dialog.current?.showModal();else dialog.current?.close();},[help]);
 useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),5000);return()=>clearTimeout(timer);},[notice]);
 const route=routes.find(r=>r.path===path),navigate=(to:string)=>{window.history.pushState({},'',to);setPath(to);};
 async function testHealth() {
  try {const res=await fetch('/api/health'),data=HealthResponse.parse(await res.json());setHealth(data.database==='ok'?'Database kết nối được':'Database chưa sẵn sàng');setNotice(res.ok?'Kiểm tra kết nối thành công':'Database chưa sẵn sàng');}
  catch {setHealth('API chưa sẵn sàng');setNotice('Không kết nối được API');}
 }
 return <div className={collapsed?'layout collapsed':'layout'}>
  <a className="skip" href="#main">Tới nội dung</a>
  <nav className="side" aria-label="Điều hướng chính"><div className="brand"><img src="/logo.png" alt="Logo Trình tải truyện"/><b>Trình tải truyện</b><button onClick={()=>collapse(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed?'Mở thanh điều hướng':'Thu gọn thanh điều hướng'}>{collapsed?'»':'«'}</button></div><small>Web 2.0 · Phase 1</small>
   <div className="menu">{routes.map(r=><a key={r.path} href={r.path} title={r.title} aria-current={path===r.path?'page':undefined} onClick={e=>{e.preventDefault();navigate(r.path);}}><span>{r.icon}</span><span className="label">{r.title}</span></a>)}</div>
   <button className="help" onClick={()=>showHelp(true)}>❔ <span className="label">Hướng dẫn</span></button>
  </nav>
  <main id="main"><header><span>Nền ứng dụng mới</span><span className="badge">Đang phát triển</span></header><section className="card"><h1>{route?.title || (path==='/'?'Trình tải truyện':'Không tìm thấy trang')}</h1>
   <p>{route?`Chức năng này sẽ triển khai ở Phase ${route.phase}. Hiện chỉ có khung giao diện; chưa truy cập thư viện thật.`:path==='/'?'Chọn một mục để xem tiến độ triển khai. Ứng dụng Apps Script hiện tại tiếp tục dùng bình thường.':'Đường dẫn này chưa có trong ứng dụng.'}</p>
   <p>Đăng nhập Google và kiểm tra quyền sẽ được bổ sung ở Phase 2.</p><div className="status"><span>{health}</span><button onClick={testHealth}>Kiểm tra kết nối</button></div>
  </section></main>
  <dialog ref={dialog} onCancel={()=>showHelp(false)} onClose={()=>showHelp(false)} aria-labelledby="help-title"><h2 id="help-title">Hướng dẫn</h2><p>Ứng dụng giữ ba mục quen thuộc: Tải sách, Quản lý sách và Đọc truyện. Mục Quản trị sẽ dành cho tài khoản được cấp quyền.</p><p>Phase 1 chỉ xây nền dự án. Các thao tác sách và đăng nhập chưa hoạt động.</p><button autoFocus onClick={()=>showHelp(false)}>Đóng</button></dialog>
  {notice&&<div className="toast" role="status">{notice}</div>}
 </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
