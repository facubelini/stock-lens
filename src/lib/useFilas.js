import { useMemo } from 'react'
import { useJson } from './useJson'
import { useDatosCombinados } from './useDatosCombinados'
import { useClasificacion, aplicarClasificacion } from './clasificacion'

// Filas de un JSON del pipeline con las clasificaciones manuales ya
// aplicadas. Acepta los dos formatos que escribe el pipeline: array plano o
// { acciones: [...] }. Reemplaza el patron repetido en cada pagina.
export function useFilas(nombre) {
  const { data, cargando, error } = useJson(nombre)
  const { overrides } = useClasificacion()
  const raw = useMemo(() => (Array.isArray(data) ? data : (data?.acciones ?? [])), [data])
  const filas = useMemo(() => aplicarClasificacion(raw, overrides), [raw, overrides])
  return { filas, data, cargando, error }
}

// Idem para listado + medias + fundamentales combinados.
export function useFilasCombinadas() {
  const { filas: base, cargando, error } = useDatosCombinados()
  const { overrides } = useClasificacion()
  const filas = useMemo(() => aplicarClasificacion(base, overrides), [base, overrides])
  return { filas, cargando, error }
}
