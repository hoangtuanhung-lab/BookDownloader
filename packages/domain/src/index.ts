import type { BookMetadata } from '../../contracts/src/index';
export type { BookRepository, DriveStorage, HttpFetcher, JobRepository, Clock } from './ports';
export function formatBookInfo(book:Pick<BookMetadata,'name'|'author'|'genres'|'sourceUrl'>):string {
  return ['##Tên truyện',book.name,'','##Tác giả',book.author,'','##Thể loại',book.genres.join(', '),'','##link gốc',book.sourceUrl,''].join('\n');
}
export function matchesDomain(host:string,domain:string):boolean {
  const h=host.toLowerCase().replace(/^www\./,''), d=domain.toLowerCase().replace(/^www\./,'');
  return !!d && (h===d || h.endsWith('.'+d));
}
