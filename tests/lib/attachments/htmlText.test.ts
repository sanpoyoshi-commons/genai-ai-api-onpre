import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractHtmlText } from '../../../src/lib/attachments/htmlText.js';

const bytesOf = (html: string) => new Uint8Array(Buffer.from(html, 'utf8'));
const extract = (html: string) => extractHtmlText(bytesOf(html));

/**
 * `<pre>` を差し戻すための目印の素。`src/lib/attachments/htmlText.ts` の `PRE_MARKER_SEED` と
 * 同じ文字列をここに書く（本文に目印と同じ文字列が来た場合を試すため。片方だけ変えると
 * 下の「本文に目印と同じ文字列」の試験が何も試さなくなる）。
 */
const MARKER_SEED = '\u241fpre\u241f';

// shiki で色付けしたコード。1 行が span で包まれ、字下げも span の中の文字として入っている。
const SHIKI_HTML = `<p>前の文</p>
<pre class="shiki github-dark"><code><span class="line"><span style="color:#F97583">def</span><span style="color:#B392F0"> f</span><span style="color:#E1E4E8">():</span></span>
<span class="line"><span style="color:#E1E4E8">    </span><span style="color:#F97583">return</span><span style="color:#79B8FF"> 1</span></span></code></pre>
<p>後の文</p>`;

test('色付けしたコード：タグは文字として残らず、改行と字下げが残る', () => {
  const text = extract(SHIKI_HTML);

  assert.ok(!text.includes('<span'), 'span のタグが文字として残っている');
  assert.ok(!text.includes('class="line"'), 'class の属性が文字として残っている');
  assert.ok(!text.includes('color:#'), 'style の属性が文字として残っている');
  assert.ok(text.includes('def f():\n    return 1'), `改行か字下げが落ちている: ${text}`);
  assert.equal(text, '前の文\ndef f():\n    return 1\n後の文');
});

test('素の pre：Python と YAML の字下げが残る', () => {
  const text = extract(`<pre>def f():
    if True:
        return 1
</pre>
<pre>
root:
  key: value
  list:
    - a
</pre>`);

  assert.equal(text, 'def f():\n    if True:\n        return 1\nroot:\n  key: value\n  list:\n    - a');
});

test('pre の中の実体参照は文字に戻る', () => {
  assert.equal(extract('<pre>if (a &lt; b &amp;&amp; c &gt; d) {}</pre>'), 'if (a < b && c > d) {}');
  assert.equal(extract('<pre>&quot;x&quot;\n&#39;y&#39;</pre>'), '"x"\n\'y\'');
});

test('pre の中の script は落ちる', () => {
  const text = extract('<pre>before<script>alert("instruction")</script>after</pre>');

  assert.ok(!text.includes('alert'), `script の中身が残っている: ${text}`);
  assert.ok(!text.includes('<script'), `script のタグが文字として残っている: ${text}`);
  assert.ok(text.includes('before'), 'script の前の文字が消えている');
  assert.ok(text.includes('after'), 'script の後の文字が消えている');
});

test('入れ子の pre は外側だけを扱う（中身は二重にならない）', () => {
  const text = extract('<pre>outer\n  <pre>inner</pre>\n  tail</pre>');

  assert.equal(text.match(/inner/g)?.length, 1, `inner が二重になっている: ${text}`);
  assert.ok(text.includes('outer'), 'outer が消えている');
  assert.ok(text.includes('tail'), 'tail が消えている');
});

test('pre の外の文の扱いは変わらない（空白の整理・空行の圧縮・script の除去）', () => {
  const text = extract(`<!doctype html><html><head><title>題</title>
<style>body{color:red}</style></head><body>
<h1>見出し</h1>
<p>1つ目の   段落
です。</p>


<p>2つ目の段落。</p>
<noscript>NOSCRIPT</noscript>
<script>BAD()</script>
</body></html>`);

  assert.equal(text, '題\n見出し\n1つ目の 段落\nです。\n2つ目の段落。');
});

test('本文に目印と同じ文字列があっても壊れない', () => {
  const inBody = `${MARKER_SEED}0${MARKER_SEED}`;
  const text = extract(`<p>本文に ${inBody} という文字列があります。</p><pre>code
  line</pre>`);

  assert.ok(text.includes(`本文に ${inBody} という文字列があります。`), `本文の文字列が置き換えられている: ${text}`);
  assert.ok(text.includes('code\n  line'), `pre の中身が戻っていない: ${text}`);
  assert.equal(text.match(/code/g)?.length, 1, `pre の中身が二重になっている: ${text}`);
});

test('pre の中の未エスケープの < はタグとして扱われる（ブラウザの表示と同じ）', () => {
  // `<pre>` の中身を普通に解析させた結果。`<int>` は知らない要素として消える＝ブラウザが
  // 表示する文字と同じになる。エスケープしてある HTML（正しい HTML）では文字として残る。
  assert.equal(extract('<pre>vector<int> v;</pre>'), 'vector v;');
  assert.equal(extract('<pre>vector&lt;int&gt; v;</pre>'), 'vector<int> v;');
  // タグに見えない `<`（後ろが空白）はそのまま残る。
  assert.equal(extract('<pre>if (a < b) {}</pre>'), 'if (a < b) {}');
});

test('pre が空でも空行を作らない', () => {
  assert.equal(extract('<p>前</p><pre></pre><p>後</p>'), '前\n後');
  assert.equal(extract('<p>前</p><pre>\n  \n</pre><p>後</p>'), '前\n後');
});
