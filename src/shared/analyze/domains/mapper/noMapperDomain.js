export function createNoMapperDomain({ mapperId = 'fixedPrg' } = {}) {
  const state = Object.freeze({ kind: 'fixed' });
  return {
    id: `${mapperId}:mapperDomain`,
    domainKind: 'mapper',
    bottom() { return { kind: 'bottom' }; },
    top() { return state; },
    initialForContext() { return state; },
    clone(value) { return value?.kind === 'bottom' ? this.bottom() : state; },
    leq(a, b) { return a?.kind === 'bottom' || b?.kind === 'fixed'; },
    join(a, b) { return a?.kind === 'bottom' ? this.clone(b) : (b?.kind === 'bottom' ? this.clone(a) : state); },
    widen(a, b) { return this.join(a, b); },
    equals(a, b) { return this.clone(a).kind === this.clone(b).kind; },
    key() { return 'fixed'; },
    toSerializable(value) { return this.clone(value); },
    fromSerializable(value) { return this.clone(value); },
    transferWrite(value) { return this.clone(value); },
    resolveCpuAddress(_value, cpuAddr) {
      const addr = cpuAddr & 0xffff;
      return { kind: 'unknown', cpuAddr: addr, reason: 'noMapperDomainDoesNotResolvePhysicalPrg' };
    }
  };
}
