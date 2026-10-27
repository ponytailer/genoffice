import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appBinaryForResources } from '../src/resources'

describe('appBinaryForResources', () => {
  it('finds the app in a custom Windows install directory', () => {
    expect(appBinaryForResources(join('D:\\Apps\\CMLG Office', 'resources'), 'win32')).toBe(
      join('D:\\Apps\\CMLG Office', 'CMLG Office.exe'),
    )
  })

  it('resolves the same binary for the default Windows install directory', () => {
    const localAppData = 'C:\\Users\\test\\AppData\\Local'
    const resources = join(localAppData, 'Programs', 'CMLG Office', 'resources')
    expect(appBinaryForResources(resources, 'win32')).toBe(
      join(localAppData, 'Programs', 'CMLG Office', 'CMLG Office.exe'),
    )
  })

  it('finds the app in a custom macOS bundle location', () => {
    expect(
      appBinaryForResources(join('/Volumes/Work/CMLG Office.app/Contents/Resources'), 'darwin'),
    ).toBe(join('/Volumes/Work/CMLG Office.app/Contents/MacOS/CMLG Office'))
  })

  it('finds the app in a custom Linux prefix', () => {
    expect(appBinaryForResources(join('/opt/cmlg-office-custom/resources'), 'linux')).toBe(
      join('/opt/cmlg-office-custom/cmlg-office'),
    )
  })
})
