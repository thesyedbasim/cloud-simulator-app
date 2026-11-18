import { useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Download, FilePlus2, ImageDown, LayoutTemplate, Link2, Plus, Upload, X } from 'lucide-react'
import { useStore } from '../store/useStore'
import { PRESETS } from '../presets/index'
import { copyShareLink, exportImage, exportJson, importFile, newBlank, openDesign } from '../app/projectActions'

const item = 'flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 outline-none data-[highlighted]:bg-line/10'

/** Project name (editable), starter designs, and file actions. */
export function ProjectMenu() {
  const name = useStore((s) => s.architecture.name)
  const savedAt = useStore((s) => s.savedAt)
  const fileRef = useRef<HTMLInputElement>(null)
  const [tpl, setTpl] = useState(false)
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
          <button className="flex items-center gap-1 whitespace-nowrap rounded-control border border-line/15 px-2 py-1.5 text-xs transition-colors hover:bg-line/10 data-[state=open]:bg-line/10 active:scale-95" aria-label="New project and files">
            <Plus size={13} className="text-accent" /><span className="hidden md:inline">New project</span><ChevronDown size={12} className="text-dim" />
          </button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content align="start" sideOffset={8} className="panel z-40 w-72 p-1 shadow-lg shadow-line/10 outline-none" style={{ background: 'var(--bp-surface)' }}>
            <Menu.Item className={item} onSelect={newBlank}><FilePlus2 size={14} /> Create a new blank project</Menu.Item>
            <Menu.Item className={item} onSelect={() => setTpl(true)}><LayoutTemplate size={14} /> Create from a template…</Menu.Item>
            <Menu.Item className={item} onSelect={() => fileRef.current?.click()}><Upload size={14} /> Import project…</Menu.Item>
            <Menu.Separator className="my-1 h-px bg-line/10" />
            <Menu.Item className={item} onSelect={exportJson}><Download size={14} /> Export project file</Menu.Item>
            <Menu.Item className={item} onSelect={() => { void exportImage() }}><ImageDown size={14} /> Export image (PNG)</Menu.Item>
            <Menu.Item className={item} onSelect={() => { void copyShareLink() }}><Link2 size={14} /> Copy share link</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <Dialog.Root open={tpl} onOpenChange={setTpl}>
        <Dialog.Portal>
          <Dialog.Overlay className="fade-in fixed inset-0 z-40 bg-black/30" />
          <Dialog.Content className="panel dlg-in fixed left-1/2 top-1/2 z-50 flex max-h-[min(88vh,640px)] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col outline-none" style={{ background: 'var(--bp-surface)' }}>
            <div className="flex items-center justify-between border-b border-line/10 px-4 py-3">
              <Dialog.Title className="text-sm font-semibold">Start from a template</Dialog.Title>
              <Dialog.Close aria-label="Close" className="grid size-6 place-items-center rounded text-dim hover:bg-line/10 hover:text-text"><X size={14} /></Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">Pick a template to open as a new project</Dialog.Description>
            <div className="flex flex-col gap-2 overflow-y-auto p-3">
              {PRESETS.map((p) => (
                <button key={p.id} onClick={() => { openDesign(p.arch, `Opened ${p.name}`); setTpl(false) }}
                  className="flex flex-col items-start gap-0.5 rounded-control border border-line/15 px-3 py-2.5 text-left transition-colors hover:bg-line/10">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-[11px] leading-snug text-dim">{p.blurb}</span>
                  <span className="text-[11px] leading-snug text-strained">Weak point: {p.weak}</span>
                </button>
              ))}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
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
