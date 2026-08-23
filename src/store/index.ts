// Side-effect import: binds the project's station types to the domain-layer
// fixture registry. Must run before anything resolves a catalog id, which is
// why it sits at the top of the store barrel every page already imports.
import './stationTypeSync';

export {
  useProject,
  downloadProjectJson,
  pickProjectFile,
  PROJECT_SCHEMA_VERSION,
  type ProjectState,
  type ProjectMeta,
  type SkillMatrix,
  type YamazumiAssignment,
  type Scenario,
  type ScenarioKpis,
  type Floor,
  type Line,
  type FactoryStructure,
  type OrderDraft,
} from './project';
export {
  useFactoryLibrary,
  archiveAndStartFresh,
  isFactoryNameTaken,
  FACTORY_LIBRARY_MAX,
  type SavedFactory,
} from './factoryLibrary';
export { useGarments, effectiveGarments, type EffectiveGarments } from './garments';
export {
  downloadSwproj,
  applySwproj,
  parseSwproj,
  buildSwproj,
  type SwprojEnvelope,
  type ParsedSwproj,
  type ApplySwprojResult,
  type TwinExport,
} from './swproj';
