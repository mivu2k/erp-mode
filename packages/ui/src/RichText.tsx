'use client';
import { useEffect, useRef, useState } from 'react';
import { cx } from './primitives';

/**
 * Display-safe HTML, parsed by the browser (not regex): drops script/style/frames/forms/objects, every on* handler,
 * and javascript:/data:text URLs. Used before any stored HTML is put into the app page.
 */
export function cleanHtml(html: string): string {
  if (typeof DOMParser === 'undefined' || !html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,iframe,frame,object,embed,form,input,button,textarea,select,link,meta,base,template,noscript,svg,math').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      const v = a.value.trim().toLowerCase();
      if (a.name.startsWith('on') || (['href', 'src', 'xlink:href', 'action', 'formaction'].includes(a.name) && (v.startsWith('javascript:') || v.startsWith('vbscript:') || (v.startsWith('data:') && !v.startsWith('data:image/'))))) el.removeAttribute(a.name);
    }
  });
  return doc.body.innerHTML;
}

/** Stored rich text shown read-only (cleaned first). */
export function RichView({ html, className }: { html: string; className?: string }) {
  return <div className={cx('max-w-none text-sm [&_blockquote]:border-s-4 [&_blockquote]:ps-3 [&_img]:max-w-full [&_ol]:list-decimal [&_ol]:ps-6 [&_ul]:list-disc [&_ul]:ps-6 [&_a]:text-primary [&_a]:underline', className)} dangerouslySetInnerHTML={{ __html: cleanHtml(html) }} />;
}

/**
 * WYSIWYG editor on the browser's built-in contentEditable/execCommand (no dependency).
 * Emits HTML; "</>" flips to the raw HTML source. The server sanitises whatever is saved.
 */
// ponytail: document.execCommand is deprecated but supported by every browser; swap for a library if it ever breaks.
export function RichText({ id, value, onChange, disabled, minHeight = 180 }: { id?: string; value: string; onChange(html: string): void; disabled?: boolean; minHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState(false);
  // Keep the editable div in sync without resetting the caret on every keystroke.
  useEffect(() => { if (ref.current && ref.current.innerHTML !== (value ?? '')) ref.current.innerHTML = cleanHtml(value ?? ''); }, [value, source]);
  const emit = () => onChange(ref.current?.innerHTML === '<br>' ? '' : (ref.current?.innerHTML ?? ''));
  const cmd = (name: string, arg?: string) => { ref.current?.focus(); document.execCommand(name, false, arg); emit(); };

  const btn = (label: string, title: string, on: () => void, extra?: string) => (
    <button type="button" title={title} aria-label={title} disabled={disabled || (source && title !== 'HTML source')} onMouseDown={(e) => e.preventDefault()} onClick={on}
      className={cx('grid h-7 min-w-7 place-items-center rounded px-1 text-[13px] text-foreground/80 hover:bg-muted disabled:opacity-40', extra)}>{label}</button>
  );
  const sel = (title: string, options: [string, string][], on: (v: string) => void) => (
    <select aria-label={title} title={title} disabled={disabled || source} defaultValue="" onChange={(e) => { on(e.target.value); e.target.value = ''; }}
      className="h-7 rounded border border-border bg-card px-1 text-xs">
      <option value="" disabled>{title}</option>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
  const sep = <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />;

  return (
    <div className={cx('overflow-hidden rounded-lg border border-border bg-card', disabled && 'opacity-70')}>
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border bg-muted/40 p-1" role="toolbar" aria-label="Formatting">
        {sel('Font', [['Arial', 'Arial'], ['Georgia', 'Georgia'], ['Times New Roman', 'Times'], ['Verdana', 'Verdana'], ['Courier New', 'Monospace']], (v) => cmd('fontName', v))}
        {sel('Size', [['2', 'Small'], ['3', 'Normal'], ['5', 'Large'], ['6', 'Huge']], (v) => cmd('fontSize', v))}
        {sep}
        {btn('B', 'Bold', () => cmd('bold'), 'font-bold')}{btn('I', 'Italic', () => cmd('italic'), 'italic')}{btn('U', 'Underline', () => cmd('underline'), 'underline')}{btn('S', 'Strikethrough', () => cmd('strikeThrough'), 'line-through')}
        {sep}
        {btn('❝', 'Quote', () => cmd('formatBlock', 'blockquote'))}{btn('‹›', 'Code', () => cmd('formatBlock', 'pre'))}
        {btn('H1', 'Heading 1', () => cmd('formatBlock', 'h2'), 'font-semibold')}{btn('H2', 'Heading 2', () => cmd('formatBlock', 'h3'), 'font-semibold')}{btn('¶', 'Paragraph', () => cmd('formatBlock', 'p'))}
        {sep}
        {btn('1.', 'Numbered list', () => cmd('insertOrderedList'))}{btn('•', 'Bullet list', () => cmd('insertUnorderedList'))}{btn('⇤', 'Outdent', () => cmd('outdent'))}{btn('⇥', 'Indent', () => cmd('indent'))}
        {sep}
        {btn('x₂', 'Subscript', () => cmd('subscript'))}{btn('x²', 'Superscript', () => cmd('superscript'))}
        {btn('⇆', 'Right-to-left', () => { const b = window.getSelection()?.anchorNode?.parentElement?.closest('p,div,h2,h3,li,blockquote'); if (b) { b.setAttribute('dir', b.getAttribute('dir') === 'rtl' ? 'ltr' : 'rtl'); emit(); } })}
        {sel('Align', [['justifyLeft', 'Left'], ['justifyCenter', 'Center'], ['justifyRight', 'Right'], ['justifyFull', 'Justify']], (v) => cmd(v))}
        {sep}
        <label title="Text colour" className="grid h-7 w-7 cursor-pointer place-items-center rounded text-[13px] font-semibold underline decoration-2 hover:bg-muted">A
          <input type="color" className="sr-only" aria-label="Text colour" disabled={disabled || source} onChange={(e) => cmd('foreColor', e.target.value)} /></label>
        <label title="Highlight" className="grid h-7 w-7 cursor-pointer place-items-center rounded text-[13px] hover:bg-muted">▨
          <input type="color" className="sr-only" aria-label="Highlight colour" disabled={disabled || source} onChange={(e) => cmd('hiliteColor', e.target.value)} /></label>
        {sep}
        {btn('🔗', 'Link', () => { const url = prompt('Link address (https://…)'); if (url && /^(https?:|mailto:|tel:)/i.test(url)) cmd('createLink', url); })}
        {btn('🖼', 'Image', () => file.current?.click())}
        {btn('Tx', 'Clear formatting', () => { cmd('removeFormat'); cmd('formatBlock', 'p'); })}
        <span className="ms-auto" />
        {btn('</>', 'HTML source', () => { if (source && ref.current) ref.current.innerHTML = cleanHtml(value ?? ''); setSource((s) => !s); }, source ? 'bg-primary/15 text-primary' : '')}
      </div>
      {/* Images are embedded (data URLs) so brochures and PDFs stay self-contained. */}
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Insert image" onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        if (f.size > 1_500_000) return alert('Image too large (max 1.5 MB)');
        const url = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(f); });
        cmd('insertImage', url);
      }} />
      {source ? (
        <textarea id={id} aria-label="HTML source" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} spellCheck={false}
          className="block w-full resize-y bg-card p-3 font-mono text-xs outline-none" style={{ minHeight }} />
      ) : (
        <div id={id} ref={ref} role="textbox" aria-multiline="true" contentEditable={!disabled} suppressContentEditableWarning onInput={emit} onBlur={emit}
          className="prose-sm max-w-none p-3 text-sm outline-none [&_blockquote]:border-s-4 [&_blockquote]:border-border [&_blockquote]:ps-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_img]:max-w-full [&_ol]:list-decimal [&_ol]:ps-6 [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:ps-6 [&_a]:text-primary [&_a]:underline"
          style={{ minHeight, resize: 'vertical', overflow: 'auto' }} />
      )}
    </div>
  );
}
