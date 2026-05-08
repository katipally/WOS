import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSkillsMigrationV2, isMigrationV2Done } from '../migrateV2'
import { _resetWosHomeForTests } from '../../paths'

function makeSkill(dir: string, id: string, frontmatter: Record<string, string>) {
  const skillDir = path.join(dir, id)
  fs.mkdirSync(skillDir, { recursive: true })
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${fm}\n---\nbody\n`)
}

describe('skills migration v2', () => {
  let tmp: string
  let prevHome: string | undefined
  let prevE2E: string | undefined

  beforeEach(() => {
    prevHome = process.env.WOS_HOME
    prevE2E = process.env.WOS_E2E
    delete process.env.WOS_E2E
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-mig-'))
    process.env.WOS_HOME = tmp
    _resetWosHomeForTests()
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.WOS_HOME
    else process.env.WOS_HOME = prevHome
    if (prevE2E === undefined) delete process.env.WOS_E2E
    else process.env.WOS_E2E = prevE2E
    _resetWosHomeForTests()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('moves a skill with agent: meeting frontmatter into agents/meeting/skills/', () => {
    const skillsRoot = path.join(tmp, 'skills')
    fs.mkdirSync(skillsRoot, { recursive: true })
    makeSkill(skillsRoot, 'note-taking', { name: 'note-taking', agent: 'meeting' })
    makeSkill(skillsRoot, 'global-helper', { name: 'global-helper' })

    const result = runSkillsMigrationV2()
    expect(result).not.toBeNull()
    expect(result!.moved).toHaveLength(1)
    expect(result!.moved[0].pack).toBe('meeting')
    expect(fs.existsSync(path.join(tmp, 'agents', 'meeting', 'skills', 'note-taking', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(skillsRoot, 'note-taking'))).toBe(false)
    expect(fs.existsSync(path.join(skillsRoot, 'global-helper'))).toBe(true)
    expect(isMigrationV2Done()).toBe(true)
  })

  it('is idempotent: second run is a no-op', () => {
    const skillsRoot = path.join(tmp, 'skills')
    fs.mkdirSync(skillsRoot, { recursive: true })
    makeSkill(skillsRoot, 'plan', { name: 'plan', agent: 'projects' })
    runSkillsMigrationV2()
    const second = runSkillsMigrationV2()
    expect(second).toBeNull()
  })

  it('skips entirely when WOS_E2E=1', () => {
    process.env.WOS_E2E = '1'
    const skillsRoot = path.join(tmp, 'skills')
    fs.mkdirSync(skillsRoot, { recursive: true })
    makeSkill(skillsRoot, 'plan', { name: 'plan', agent: 'projects' })
    const result = runSkillsMigrationV2()
    expect(result).toBeNull()
    expect(fs.existsSync(path.join(skillsRoot, 'plan'))).toBe(true)
    expect(isMigrationV2Done()).toBe(false)
  })

  it('ignores unknown agent values', () => {
    const skillsRoot = path.join(tmp, 'skills')
    fs.mkdirSync(skillsRoot, { recursive: true })
    makeSkill(skillsRoot, 'odd', { name: 'odd', agent: 'made-up-pack' })
    const result = runSkillsMigrationV2()
    expect(result!.moved).toHaveLength(0)
    expect(fs.existsSync(path.join(skillsRoot, 'odd'))).toBe(true)
  })
})
