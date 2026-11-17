import { useRef } from 'react'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Download, FilePlus2, FileText, FolderOpen, ImageDown, Link2, Upload } from 'lucide-react'
import { useStore } from '../store/useStore'
import { PRESETS } from '../presets/index'
import { copyShareLink, exportImage, exportJson, exportReport, importFile, newBlank, openDesign } from '../app/projectActions'

const item = 'flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 outline-none data-[highlighted]:bg-line/10'

/** Project name (editable), starter designs, and file actions. */
export function ProjectMenu() {
  const name = useStore((s) => s.architecture.name)
  const savedAt = useStore((s) => s.savedAt)
  const fileRef = useRef<HTMLInputElement>(null)
  const rename = useStore.getState().renameProject

  return (
    <div className="flex min-w-0 items-center gap-1">
      <input
        value={name}
        onChange={(e) => rename(e.target.value)}
        aria-label="Project name"
        spellCheck={false}
        className="hidden w-40 rounded-control border border-transparent bg-transparent px-2 py-1 text-[13px] font-medium hover:border-line/20 focus:border-accent focus:outline-none lg:block xl:w-48"
      />
      <Menu.Root>
        <Menu.Trigger asChild>
          <button className="flex items-center gap-1 rounded-control border border-line/15 px-2 py-1.5 text-xs transition-colors hover:bg-line/10 data-[state=open]:bg-line/10 active:scale-95" aria-label="Designs and files">
            <FolderOpen size={13} className="text-accent" /><span className="hidden md:inline">Designs</span><ChevronDown size={12} className="text-dim" />
          </button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content align="start" sideOffset={8} className="panel z-40 w-72 p-1 shadow-lg shadow-line/10 outline-none" style={{ background: 'var(--bp-surface)' }}>
            <Menu.Label className="label px-2 py-1.5">Starter designs</Menu.Label>
            {PRESETS.map((p) => (
              <Menu.Item key={p.id} className={`${item} flex-col !items-start gap-0.5`} onSelect={() => openDesign({ ...p.arch, components: p.arch.components, connections: p.arch.connections }, `Opened ${p.name}`)}>
                <span className="font-medium">{p.name}</span>
                <span className="text-[11px] leading-snug text-dim">{p.blurb}</span>
                <span className="text-[11px] leading-snug text-strained">Weak point: {p.weak}</span>
              </Menu.Item>
            ))}
            <Menu.Separator className="my-1 h-px bg-line/10" />
            <Menu.Item className={item} onSelect={newBlank}><FilePlus2 size={14} /> New blank design</Menu.Item>
            <Menu.Item className={item} onSelect={() => fileRef.current?.click()}><Upload size={14} /> Import project file…</Menu.Item>
            <Menu.Item className={item} onSelect={exportJson}><Download size={14} /> Export project file</Menu.Item>
            <Menu.Item className={item} onSelect={() => { void exportImage() }}><ImageDown size={14} /> Export image (PNG)</Menu.Item>
            <Menu.Item className={item} onSelect={exportReport}><FileText size={14} /> Export design report (Markdown)</Menu.Item>
            <Menu.Item className={item} onSelect={() => { void copyShareLink() }}><Link2 size={14} /> Copy share link</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = '' // so picking the same file twice still fires
          if (f) void importFile(f)
        }}
      />
      {savedAt && (
        <span className="hidden items-center gap-1 text-[11px] text-dim xl:flex" title={`Saved in this browser at ${new Date(savedAt).toLocaleTimeString()}`}>
          <Check size={12} className="text-healthy" /> Saved
        </span>
      )}
    </div>
  )
}
