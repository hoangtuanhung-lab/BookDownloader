import {test,expect} from '@playwright/test';
test('protected routes show login and hide privileged menus for guests',async({page})=>{
 await page.goto('/read');await expect(page.getByRole('heading',{name:'Đăng nhập'})).toBeVisible();
 await expect(page.getByRole('link',{name:'Quản lý sách'})).toHaveCount(0);
 await page.goto('/admin');await expect(page.getByRole('heading',{name:'Đăng nhập'})).toBeVisible();
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
 await page.setViewportSize({width:390,height:844});await expect(page.getByRole('button',{name:'Đăng nhập bằng Google'})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('unknown route and API failure are honest placeholders',async({page})=>{
 await page.goto('/missing');await expect(page.getByRole('heading',{name:'Đăng nhập'})).toBeVisible();
 await page.route('**/api/health',route=>route.fulfill({status:503,json:{status:'unavailable',database:'unavailable',correlationId:'10000000-0000-4000-8000-000000000001'}}));
 await page.getByRole('button',{name:'Kiểm tra kết nối'}).click();await expect(page.getByRole('status')).toHaveText('Database chưa sẵn sàng');
});
