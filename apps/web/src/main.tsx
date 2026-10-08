import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {hasPermission,HealthResponse,type Permission} from '../../../packages/contracts/src/index';
import {authClient,googleLogin} from './auth/client';
import {useAccount} from './auth/useAccount';
import {Admin} from './Admin';
import './styles.css';
const routes:[string,string,string,Permission,number][]=[['/read','📖','Đọc truyện','read',4],['/download','⬇️','Tải sách','download',6],['/manage','📚','Quản lý sách','manage',5],['/admin','⚙️','Quản trị','admin',2]];
function App(){
 const auth=useAccount();
 const [path,setPath]=useState(window.location.pathname),[collapsed,collapse]=useState(false),[help,showHelp]=useState(false),[notice,setNotice]=useState(''),[health,setHealth]=useState('Chưa kiểm tra');
 const dialog=useRef<HTMLDialogElement>(null),lastUser=useRef<string|null>(null);
 const navigate=(to:string,replace=false)=>{window.history[replace?'replaceState':'pushState']({},'',to);setPath(to);};
 useEffect(()=>{const fn=()=>setPath(window.location.pathname);window.addEventListener('popstate',fn);return()=>window.removeEventListener('popstate',fn);},[]);
 useEffect(()=>{if(help)dialog.current?.showModal();else dialog.current?.close();},[help]);
 useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),5000);return()=>clearTimeout(timer);},[notice]);
 useEffect(()=>{
  if(auth.account && lastUser.current!==auth.account.id){lastUser.current=auth.account.id;if(path==='/'||path==='/login'||path==='/auth/callback')navigate('/read',true);}
  if(!auth.account&&!auth.pending){lastUser.current=null;showHelp(false);setNotice('');}
 },[auth.account,auth.pending]);
 const route=routes.find(r=>r[0]===path),allowed=auth.account&&route&&hasPermission(auth.account,route[3]);
 async function testHealth(){try{const res=await fetch('/api/health'),data=HealthResponse.parse(await res.json());setHealth(data.database==='ok'?'Database kết nối được':'Database chưa sẵn sàng');setNotice(res.ok?'Kiểm tra kết nối thành công':'Database chưa sẵn sàng');}catch{setHealth('API chưa sẵn sàng');setNotice('Không kết nối được API');}}
 async function login(){try{await googleLogin();}catch(e){setNotice(e instanceof Error?e.message:'Không đăng nhập được');}}
 async function logout(){await auth.logout();setHealth('Chưa kiểm tra');navigate('/login',true);}
 return <div className={collapsed?'layout collapsed':'layout'}><a className="skip" href="#main">Tới nội dung</a><nav className="side" aria-label="Điều hướng chính"><div className="brand"><img src="/logo.png" alt="Logo Trình tải truyện"/><b>Trình tải truyện</b><button onClick={()=>collapse(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed?'Mở thanh điều hướng':'Thu gọn thanh điều hướng'}>{collapsed?'»':'«'}</button></div><small>Web 2.0 · Phase 2</small><div className="menu">{auth.account&&routes.filter(r=>hasPermission(auth.account!,r[3])).map(r=><a key={r[0]} href={r[0]} title={r[2]} aria-current={path===r[0]?'page':undefined} onClick={e=>{e.preventDefault();navigate(r[0]);}}><span>{r[1]}</span><span className="label">{r[2]}</span></a>)}</div><button className="help" onClick={()=>showHelp(true)}>❔ <span className="label">Hướng dẫn</span></button>{auth.account&&<button onClick={()=>void logout()}>Đăng xuất</button>}</nav>
 <main id="main"><header><span>{auth.account?.name||'Trình tải truyện'}</span><span className="badge">Đang phát triển</span></header><section className="card" key={auth.account?.id||'guest'}>
 {auth.pending?<p role="status">Đang kiểm tra đăng nhập…</p>:!auth.account?<><h1>Đăng nhập</h1><p>Đăng nhập bằng Google để vào mục đọc truyện. Tài khoản mới được cấp quyền đọc sách.</p>{auth.error&&<p role="alert">{auth.error}</p>}{!authClient&&<p>Đăng nhập Google chưa được cấu hình. Liên hệ quản trị viên.</p>}<button disabled={!authClient} onClick={()=>void login()}>Đăng nhập bằng Google</button></>:route&&!allowed?<><h1>Không có quyền truy cập</h1><p>Tài khoản của bạn chưa được cấp quyền cho mục này.</p></>:allowed&&path==='/admin'?<Admin account={auth.account!} call={auth.call} notify={setNotice}/>:<><h1>{route?.[2]||'Không tìm thấy trang'}</h1><p>{route?`Chức năng này sẽ triển khai ở Phase ${route[4]}. Hiện chưa truy cập thư viện thật.`:'Đường dẫn này chưa có trong ứng dụng.'}</p></>}
 <div className="status"><span>{health}</span><button onClick={()=>void testHealth()}>Kiểm tra kết nối</button></div></section></main>
 <dialog ref={dialog} onCancel={()=>showHelp(false)} onClose={()=>showHelp(false)} aria-labelledby="help-title"><h2 id="help-title">Hướng dẫn</h2><p>Đăng nhập Google để đọc sách. Mục Tải sách, Quản lý sách và Quản trị xuất hiện khi được cấp quyền tương ứng.</p><p>Thư viện đọc triển khai Phase 4; quản lý Phase 5; phân tích và tải Phase 6–7. Chưa cần kết nối Drive để đăng nhập.</p><button autoFocus onClick={()=>showHelp(false)}>Đóng</button></dialog>{notice&&<div className="toast" role="status">{notice}</div>}</div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
