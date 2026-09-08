import { expect } from 'chai'
import type { ServiceTemplatePublic } from '@oceanprotocol/lib'

import { templateToServiceStartArgs } from '../../../tools/serviceCost.js'

const TEMPLATE: ServiceTemplatePublic = {
  id: 'vllm-qwen-0_5b',
  name: 'vLLM Qwen2 0.5B',
  image: 'vllm/vllm-openai',
  tag: 'v0.6.2',
  exposedPorts: [8000],
  command: ['--model', 'Qwen/Qwen2-0.5B'],
  entrypoint: ['python', '-m', 'vllm.entrypoints.openai.api_server'],
  envVarKeys: ['MODEL_DIR', 'OPERATOR_SECRET'],
  userConfigurableEnvVars: [
    { key: 'HF_TOKEN', validation: '^hf_', sensitive: true },
    { key: 'MAX_LEN' }
  ],
  requiredResources: [
    { id: 'cpu', min: 2 },
    { id: 'ram', min: 8 },
    { kind: 'discrete', type: 'gpu', min: 1 }
  ]
}

describe('templateToServiceStartArgs', () => {
  const projected = templateToServiceStartArgs(TEMPLATE)

  it('renames command → dockerCmd and entrypoint → dockerEntrypoint', () => {
    // The whole point of this projection: `command`/`entrypoint` are not serviceStart args
    // and are silently dropped if copied verbatim.
    expect(projected.serviceStartArgs.dockerCmd).to.deep.equal([
      '--model',
      'Qwen/Qwen2-0.5B'
    ])
    expect(projected.serviceStartArgs.dockerEntrypoint).to.deep.equal([
      'python',
      '-m',
      'vllm.entrypoints.openai.api_server'
    ])
    expect(projected.serviceStartArgs).to.not.have.property('command')
    expect(projected.serviceStartArgs).to.not.have.property('entrypoint')
  })

  it('carries image, tag and exposedPorts through', () => {
    expect(projected.serviceStartArgs.image).to.equal('vllm/vllm-openai')
    expect(projected.serviceStartArgs.tag).to.equal('v0.6.2')
    expect(projected.serviceStartArgs.exposedPorts).to.deep.equal([8000])
  })

  it('projects only id-keyed requiredResources, at their minimums', () => {
    // The kind/type requirement has no id, so it cannot become a ComputeResourceRequest.
    expect(projected.serviceStartArgs.resources).to.deep.equal([
      { id: 'cpu', amount: 2 },
      { id: 'ram', amount: 8 }
    ])
  })

  it("lists userConfigurableEnvVars keys as the caller's to fill", () => {
    expect(projected.userDataKeys).to.deep.equal(['HF_TOKEN', 'MAX_LEN'])
  })

  it('keeps operator envVarKeys separate and out of the suggested userData', () => {
    expect(projected.operatorEnvVarKeys).to.deep.equal(['MODEL_DIR', 'OPERATOR_SECRET'])
    for (const key of projected.operatorEnvVarKeys) {
      expect(projected.userDataKeys).to.not.include(key)
    }
    expect(projected.serviceStartArgs).to.not.have.property('userData')
  })

  it('never fabricates a value for a sensitive key', () => {
    const serialized = JSON.stringify(projected)
    expect(projected.serviceStartArgs).to.not.have.property('userData')
    // Only the key name may appear, never a placeholder value assignment.
    expect(serialized).to.contain('HF_TOKEN')
    expect(serialized).to.not.contain('"HF_TOKEN":"')
  })

  it('preserves the raw template alongside the projection', () => {
    expect(projected.template).to.equal(TEMPLATE)
    expect(projected.template.command).to.deep.equal(['--model', 'Qwen/Qwen2-0.5B'])
  })

  it('notes what the caller still has to supply', () => {
    const notes = projected.notes.join(' ')
    expect(notes).to.contain('dockerCmd')
    expect(notes).to.contain('environment')
    expect(notes).to.contain('duration')
  })

  it('warns about in-container ports below 1024', () => {
    const low = templateToServiceStartArgs({ ...TEMPLATE, exposedPorts: [80, 8000] })
    expect(low.notes.join(' ')).to.contain('below 1024')
  })

  it('warns when the template builds from a Dockerfile', () => {
    const built = templateToServiceStartArgs({
      id: 'custom',
      image: 'my-build',
      dockerfile: 'FROM alpine\nCMD ["sleep","1"]',
      exposedPorts: [8080],
      tag: undefined
    } as ServiceTemplatePublic)
    expect(built.serviceStartArgs.dockerfile).to.be.a('string')
    expect(built.serviceStartArgs).to.not.have.property('tag')
    expect(built.notes.join(' ')).to.contain('allowImageBuild')
  })

  it('emits neither tag nor checksum when the template sets neither', () => {
    const bare = templateToServiceStartArgs({
      id: 'bare',
      image: 'nginx',
      exposedPorts: [8080]
    } as ServiceTemplatePublic)
    expect(bare.serviceStartArgs).to.not.have.property('tag')
    expect(bare.serviceStartArgs).to.not.have.property('checksum')
    expect(bare.userDataKeys).to.deep.equal([])
    expect(bare.operatorEnvVarKeys).to.deep.equal([])
  })
})
