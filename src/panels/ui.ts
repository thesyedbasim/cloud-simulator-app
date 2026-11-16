export const iconBtn = 'grid size-8 place-items-center rounded-control text-dim transition-colors hover:bg-line/10 hover:text-text active:scale-95 disabled:opacity-30 disabled:pointer-events-none'
export const slide = (dir: 1 | -1) => ({
  initial: { opacity: 0, x: 16 * dir },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 16 * dir },
  transition: { duration: 0.2, ease: [0.2, 0.8, 0.2, 1] as const },
})
