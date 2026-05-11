import { describe, it, expect } from 'vitest';
import { InMemorySchemaRegistry, YamlSchemaRegistry } from './index.js';

describe('YamlSchemaRegistry', () => {
  it('loads personas + services from config/schema-registry.yaml', () => {
    const r = new YamlSchemaRegistry();
    expect(r.hasPersona('persona-iti-seeker')).toBe(true);
    expect(r.hasService('service-bluedots-job')).toBe(true);
    expect(r.hasPersona('persona-unknown')).toBe(false);
    expect(r.hasService('service-nope')).toBe(false);
  });

  it('resolves entries to {id,name}', () => {
    const r = new YamlSchemaRegistry();
    expect(r.resolvePersona('persona-iti-seeker')).toEqual({
      id: 'persona-iti-seeker',
      name: 'ITI / Vocational Seeker',
    });
    expect(r.resolvePersona('does-not-exist')).toBeNull();
  });

  it('listPersonas + listServices return all entries', () => {
    const r = new YamlSchemaRegistry();
    expect(r.listPersonas().length).toBeGreaterThan(0);
    expect(r.listServices().length).toBeGreaterThan(0);
  });
});

describe('InMemorySchemaRegistry', () => {
  it('starts empty and accepts seeded entries', () => {
    const r = new InMemorySchemaRegistry().seed({
      personas: [{ id: 'p1', name: 'Persona 1' }],
      services: [{ id: 's1', name: 'Service 1' }],
    });
    expect(r.hasPersona('p1')).toBe(true);
    expect(r.hasService('s1')).toBe(true);
    expect(r.hasPersona('p2')).toBe(false);
  });
});
