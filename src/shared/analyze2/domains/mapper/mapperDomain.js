import { createNoMapperDomain } from './noMapperDomain.js';

const FALLBACK_DOMAIN = createNoMapperDomain({ mapperId: 'fallback' });

export function mapperDomainFromOptions(options = {}) {
  const domain = options?.mapperDomain;
  return domain && typeof domain.join === 'function' ? domain : FALLBACK_DOMAIN;
}

export function cloneMapperState(state, options = {}) {
  return mapperDomainFromOptions(options).clone(state);
}

export function topMapperState(options = {}) {
  return mapperDomainFromOptions(options).top();
}

export function initialMapperStateForContext(mapperContext, options = {}) {
  return mapperDomainFromOptions(options).initialForContext(mapperContext);
}

export function joinMapperStates(a, b, options = {}) {
  return mapperDomainFromOptions(options).join(a, b, options);
}

export function widenMapperStates(a, b, options = {}) {
  return mapperDomainFromOptions(options).widen(a, b, options);
}

export function mapperStatesEqual(a, b, options = {}) {
  return mapperDomainFromOptions(options).equals(a, b);
}

export function mapperStateSubsetOf(a, b, options = {}) {
  return mapperDomainFromOptions(options).leq(a, b);
}

export function mapperStateToSerializable(state, options = {}) {
  return mapperDomainFromOptions(options).toSerializable(state);
}

export function mapperStateFromSerializable(value, options = {}) {
  return mapperDomainFromOptions(options).fromSerializable(value);
}

export function transferMapperWrite(state, write, options = {}) {
  return mapperDomainFromOptions(options).transferWrite(state, write, options);
}

export function resolveMapperCpuAddress(state, cpuAddr, options = {}) {
  return mapperDomainFromOptions(options).resolveCpuAddress(state, cpuAddr, options);
}
