import {test,expect} from '@playwright/test';
test('sidebar navigation uses React routes and marks unfinished phases',async({page})=>{
 await page.goto('/read');await expect(page.getByRole('heading',{name:'Đọc truyện'})).toBeVisible();
 await expect(page.getByText('Chức năng này sẽ triển khai ở Phase 6.',{exact:false})).toBeVisible();
 await page.getByRole('link',{name:'Quản lý sách'}).click();await expect(page).toHaveURL(/\/manage$/);await expect(page.getByRole('heading',{name:'Quản lý sách'})).toBeVisible();
 await page.goBack();await expect(page.getByRole('heading',{name:'Đọc truyện'})).toBeVisible();
});
test('help modal has keyboard dismissal and restores focus',async({page})=>{
 await page.goto('/download');await page.getByRole('button',{name:'Hướng dẫn'}).click();await expect(page.getByRole('dialog')).toBeVisible();
 await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.getByRole('button',{name:'Hướng dẫn'})).toBeFocused();
});
test('connection button reaches DB via API and shows toast',async({page})=>{
 await page.goto('/read');await page.getByRole('button',{name:'Kiểm tra kết nối'}).click();await expect(page.getByText('Database kết nối được')).toBeVisible();await expect(page.getByRole('status')).toHaveText('Kiểm tra kết nối thành công');
});
test('collapsed sidebar and narrow layout remain usable',async({page})=>{
 await page.goto('/read');await page.getByRole('button',{name:'Thu gọn thanh điều hướng'}).click();await expect(page.getByRole('button',{name:'Mở thanh điều hướng'})).toHaveAttribute('aria-expanded','false');
 await page.setViewportSize({width:390,height:844});await page.getByRole('link',{name:'Tải sách'}).click();await expect(page.getByRole('heading',{name:'Tải sách'})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('unknown route and API failure are honest placeholders',async({page})=>{
 await page.goto('/missing');await expect(page.getByRole('heading',{name:'Không tìm thấy trang'})).toBeVisible();
 await page.route('**/api/health',route=>route.fulfill({status:503,json:{status:'unavailable',database:'unavailable',correlationId:'10000000-0000-4000-8000-000000000001'}}));
 await page.getByRole('button',{name:'Kiểm tra kết nối'}).click();await expect(page.getByRole('status')).toHaveText('Database chưa sẵn sàng');
});
