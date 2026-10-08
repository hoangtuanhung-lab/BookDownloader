import type {PoolClient} from 'pg';
import {BookMetadata,AppError} from '../../contracts/src/index';
import {formatBookInfo} from '../../domain/src/index';
import type {GoogleDriveStorage} from './drive';
/** Worker-side transaction, one database writer per book across instances.
 * Drive create is discoverable by name after a crash before commit. A failed
 * Drive write rolls back the DB success marker; outbox retry is Phase 7.
 */
export async function syncBookInfo(db:PoolClient,drive:GoogleDriveStorage,bookId:string,expectedVersion:number,ownerSubject:string){
 await db.query('begin');
 try{
  const row=(await db.query('select b.*,coalesce((select array_agg(g.name order by bg.position) from public.book_genres bg join public.genres g on g.id=bg.genre_id where bg.book_id=b.id),array[]::text[]) as genres from public.books b where b.id=$1 and b.deleted_at is null for update',[bookId])).rows[0];
  if(!row)throw new AppError('NOT_FOUND',404,'Không tìm thấy truyện');
  if(Number(row.version)!==expectedVersion)throw new AppError('CONFLICT',409,'Thông tin truyện đã thay đổi');
  const book=BookMetadata.parse({id:row.id,name:row.name,author:row.author,genres:row.genres,sourceUrl:row.source_type==='WEB'?row.source_url:'',sourceType:row.source_type,visibility:row.visibility,version:Number(row.version)});
  if(!row.folder_id)throw new AppError('DRIVE_UNCONFIGURED',503,'Truyện chưa có thư mục');
  const fileId=await drive.putText(row.folder_id,'info.txt',formatBookInfo(book),expectedVersion);
  await db.query("insert into public.drive_resources(file_id,book_id,owner_subject,kind,metadata_version,sync_status) values($1,$2,$3,'INFO',$4,'synced') on conflict(book_id,kind) where kind in ('INFO','COVER','IMPORT','REMOVED_LOG') do update set file_id=excluded.file_id,owner_subject=excluded.owner_subject,metadata_version=excluded.metadata_version,sync_status='synced'",[fileId,bookId,ownerSubject,expectedVersion]);
  await db.query('commit');return fileId;
 }catch(error){await db.query('rollback');throw error;}
}
