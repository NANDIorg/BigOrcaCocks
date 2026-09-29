import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { aboutExternalUrl, buildAboutHtml } from './about-content'

describe('безопасное содержимое окна «О приложении»', () => {
  it('открывает только две ссылки проекта, отвергая чужие адреса и схемы', () => {
    assert.equal(aboutExternalUrl('https://github.com/NANDIorg/BigOrcaCocks'), 'https://github.com/NANDIorg/BigOrcaCocks')
    assert.equal(aboutExternalUrl('https://github.com/NANDIorg/BigOrcaCocks/issues/new'), 'https://github.com/NANDIorg/BigOrcaCocks/issues/new')
    for (const url of [
      'https://github.com/NANDIorg/OtherProject',
      'https://github.com/NANDIorg/BigOrcaCocks?next=evil',
      'https://github.com/NANDIorg/BigOrcaCocks#evil',
      'https://github.com.evil.test/NANDIorg/BigOrcaCocks',
      'https://github.com@evil.test/NANDIorg/BigOrcaCocks',
      'http://github.com/NANDIorg/BigOrcaCocks',
      'file:///tmp/index.html',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>'
    ]) assert.equal(aboutExternalUrl(url), null, url)
  })

  it('версия не может превратиться в разметку или обработчик события', () => {
    const html = buildAboutHtml({ locale: 'en', version: '1.2.3 <img src=x onerror="evil()"> & \'dev\'', iconPng: new Uint8Array([137, 80, 78, 71]) })
    assert.ok(html.includes('1.2.3 &lt;img src=x onerror=&quot;evil()&quot;&gt; &amp; &#39;dev&#39;'))
    assert.ok(!html.includes('<img src=x'))
    assert.match(html, /src="data:image\/png;base64,iVBORw=="/)
    assert.ok(!html.includes('<script'))
    assert.match(html, /default-src &#39;none&#39;/)
    assert.match(html, /img-src data:/)
  })

  it('содержимое и названия ссылок берутся на языке настроек приложения', () => {
    const ru = buildAboutHtml({ locale: 'ru', version: '2.7.4', iconPng: new Uint8Array() })
    const en = buildAboutHtml({ locale: 'en', version: '2.7.4', iconPng: new Uint8Array() })
    assert.match(ru, /<html lang="ru">/)
    assert.match(en, /<html lang="en">/)
    assert.match(ru, /Версия 2\.7\.4/)
    assert.match(en, /Version 2\.7\.4/)
    assert.match(ru, />Проект на GitHub</)
    assert.match(en, />Project on GitHub</)
    assert.match(ru, />Сообщить об ошибке</)
    assert.match(en, />Report an issue</)
    assert.match(ru, /Оркестратор CLI-агентов/)
    assert.match(en, /A CLI agent orchestrator/)
    assert.equal((ru.match(/<a /g) ?? []).length, 2)
    assert.equal((en.match(/<a /g) ?? []).length, 2)
  })
})
