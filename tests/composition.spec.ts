import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('bundle composition', () => {
  it('inserts the xai-oauth host plugin, a Grok default model, and Grok web search', async () => {
    const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('provider: xai-oauth')
    expect(patch).toMatch(/model: grok-4\./)
    expect(patch).toContain('searchProvider: xai-oauth')
    expect(patch).toContain('id: llm-xai-oauth')
    expect(patch).toContain('name: dsh-xai')
  })

  it('declares a dsh bundle and web client half', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      name: string
      dsh: { bundle: { patch: string }; client: { platform: string } }
      peerDependencies: Record<string, string>
    }
    expect(manifest.name).toBe('dsh-xai')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-web']).toBe('*')
  })
})
