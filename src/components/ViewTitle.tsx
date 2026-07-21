import { SW_COLORS, SW_FONTS } from '../design/tokens';

interface ViewTitleProps {
  kicker: string;
  title: string;
  /** 'dark' when the toolbar sits on ink-coloured chrome (e.g. LiveSim HUD). */
  surface?: 'light' | 'dark';
}

/**
 * Compact page identity for canvas views whose toolbars can't afford a
 * block-level SectionHeader. Sits inline inside an existing flex toolbar
 * row and answers "where am I" without adding vertical bulk.
 */
export function ViewTitle({ kicker, title, surface = 'light' }: ViewTitleProps) {
  return (
    <div
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        justifyContent: 'center',
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
    >
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          fontWeight: 700,
          color: SW_COLORS.brand,
          letterSpacing: '1.5px',
          textTransform: 'uppercase',
        }}
      >
        {kicker}
      </div>
      <div
        style={{
          fontFamily: SW_FONTS.display,
          fontSize: 14,
          fontWeight: 900,
          letterSpacing: '-0.01em',
          lineHeight: 1.1,
          color: surface === 'dark' ? '#fff' : SW_COLORS.ink,
        }}
      >
        {title}
      </div>
    </div>
  );
}
