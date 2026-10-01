import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deviceLabel,geoLabel} from '../lib/client-info.mjs';
test('device labels distinguish mobile browsers and tablets without guessing hardware model',()=>{
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/140.0 Mobile/15 Safari/604.1'),'Телефон · iOS / iPadOS · Chrome');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36 EdgA/140.0'),'Телефон · Android · Edge');
  assert.match(deviceLabel('Mozilla/5.0 (Linux; Android 15) Chrome/140 Safari/537.36 SamsungBrowser/25'),/^Планшет.*Samsung Internet$/);
  assert.match(deviceLabel('Mozilla/5.0 (Windows NT 10.0) Chrome/140 Safari/537.36 YaBrowser/25'),/^Компьютер.*Яндекс/);
  assert.match(deviceLabel('Mozilla/5.0 (iPad) FxiOS/140 Safari/604.1'),/^Планшет.*Firefox$/);
  assert.match(deviceLabel('CompanyAssistant/1.0 (Macintosh)'),/Приложение$/);
});
test('GeoIP uses Russian names, English fallback, and tolerates unknown/private addresses',()=>{
  assert.equal(geoLabel({get:()=>({country:{names:{ru:'Россия',en:'Russia'}},city:{names:{en:'Moscow'}}})},'1.2.3.4'),'Россия, Moscow');
  assert.equal(geoLabel({get:()=>null},'127.0.0.1'),'Не определено');
  assert.equal(geoLabel({get:()=>{throw Error();}},'invalid'),'Не определено');
  assert.match(geoLabel(null,'1.2.3.4'),/недоступна/);
});
