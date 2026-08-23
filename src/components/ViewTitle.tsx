import { SW_COLORS, SW_FONTS } from '../design/tokens';

interface ViewTitleProps {
  title: string;
  /** 'dark' when the toolbar sits on ink-coloured chrome (e.g. LiveSim HUD). */
  surface?: 'light' | 'dark';
}

/**
 * Compact page identity for canvas views whose toolbars can't afford a
 * block-level SectionHeader. Sits inline inside an existing flex toolbar
 * row and answers "where am I" without adding vertical bulk.
 *
 * There used to be a brand-orange kicker stacked above the title
 * (AUTHORING / SIMULATION). It restated what the title and the lit nav rail
 * already said, and being the only orange text in the top bar it pulled the
 * eye away from SIMULATE — the one control up there that should shout. One
 * line, one job.
 */
export function ViewTitle({ title, surface = 'light' }: ViewTitleProps) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        fontFamily: SW_FONTS.display,
        fontSize: 16,
        fontWeight: 900,
        letterSpacing: '-0.01em',
        lineHeight: 1.1,
        color: surface === 'dark' ? '#fff' : SW_COLORS.ink,
      }}
    >
      {title}
    </div>
  );
}
