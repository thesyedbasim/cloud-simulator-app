import { beforeEach, describe, expect, it } from 'vitest'
import { linkShortener } from '../presets/linkShortener'
import { useSim, withChallengeControl } from '../sim/runtime'
import { runLocked, useChallenges } from './challengeStore'
import { useStore } from './useStore'

const app = () => useStore.getState().architecture.components.find((c) => c.id === 'app')!

describe('design lock during a challenge run', () => {
  beforeEach(() => {
    useChallenges.setState({ activeId: 'black-friday', phase: 'design', tab: 'challenge', outcome: null, attempts: 0 })
    useStore.getState().loadArchitecture(JSON.parse(JSON.stringify(linkShortener)))
    useSim.setState({ shape: 'steady', injected: {}, scenario: null })
  })

  it('lets the design be edited in design mode', () => {
    useStore.getState().updateConfig('app', 'instances', 4)
    expect(app().config.instances).toBe(4)
    expect(runLocked()).toBe(false)
  })

  it('refuses every kind of edit while a run is playing', () => {
    useChallenges.setState({ phase: 'running' })
    expect(runLocked()).toBe(true)
    const st = useStore.getState()
    const before = st.architecture
    st.updateConfig('app', 'instances', 9)
    st.updateConfigs('app', { instances: 9 })
    st.moveComponent('app', 20, 20)
    st.renameComponent('app', 'Renamed')
    st.removeComponent('db')
    st.duplicateComponent('app')
    st.removeConnection('c1')
    st.updateConnection('c2', { weight: 5 })
    expect(st.addComponent('cache', 12, 12)).toBe('')
    expect(st.addNear('cache', { col: 12, row: 12 })).toBeNull()
    expect(st.addConnection('client', 'db')).toBe('locked')
    expect(useStore.getState().architecture).toBe(before) // nothing at all changed
  })

  it('also refuses undo and redo, which would swap the design out from under the run', () => {
    useStore.getState().updateConfig('app', 'instances', 4)
    useChallenges.setState({ phase: 'running' })
    useStore.getState().undo()
    expect(app().config.instances).toBe(4)
  })

  it('unlocks again as soon as the run is over', () => {
    for (const phase of ['won', 'lost', 'design'] as const) {
      useChallenges.setState({ phase })
      useStore.getState().updateConfig('app', 'instances', 3)
      expect(app().config.instances).toBe(3)
      useStore.getState().updateConfig('app', 'instances', 2)
    }
  })

  it('does not lock anything when no challenge is in progress', () => {
    useChallenges.setState({ activeId: null, phase: null })
    useStore.getState().updateConfig('app', 'instances', 6)
    expect(app().config.instances).toBe(6)
  })

  it('keeps the incident and traffic out of the player\'s hands during a run, but not out of the run\'s own', () => {
    useChallenges.setState({ phase: 'running' })
    useSim.getState().setShape('spike')
    useSim.getState().inject('app', 'killed')
    expect(useSim.getState().shape).toBe('steady')
    expect(useSim.getState().injected).toEqual({})
    withChallengeControl(() => useSim.getState().setShape('spike'))
    expect(useSim.getState().shape).toBe('spike')
  })

  it('selecting something on the canvas shows the Inspector, even from the Challenge tab', () => {
    useChallenges.setState({ phase: 'design', tab: 'challenge' })
    useStore.getState().select('app')
    expect(useChallenges.getState().tab).toBe('inspector')
    useChallenges.setState({ tab: 'challenge' })
    useStore.getState().selectConn('c1')
    expect(useChallenges.getState().tab).toBe('inspector')
  })

  it('starting and abandoning a challenge sets up and clears its state', () => {
    useChallenges.getState().start('lose-a-server')
    expect(useChallenges.getState()).toMatchObject({ activeId: 'lose-a-server', phase: 'design', tab: 'challenge', outcome: null, attempts: 0 })
    useChallenges.getState().beginAttempt()
    expect(useChallenges.getState().attempts).toBe(1)
    useChallenges.getState().abandon()
    expect(useChallenges.getState()).toMatchObject({ activeId: null, phase: null, tab: 'inspector' })
  })
})
