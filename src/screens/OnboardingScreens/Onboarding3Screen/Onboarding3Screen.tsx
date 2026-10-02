import React from 'react';
import {observer} from 'mobx-react';

import {OnboardingScaffold} from '../components/OnboardingScaffold';
import {OnboardingBottomBar} from '../components/OnboardingBottomBar';
import {OnboardingContent} from '../components/OnboardingContent';
import {ItalicAccentTitle} from '../components/ItalicAccentTitle';
import {HighlightText} from '../components/HighlightText';
import {useOnboardingHandlers} from '../useOnboardingHandlers';
import {LocalVsCloudCards} from './LocalVsCloudCards';

// Screen 3 "Cards" composition is a flat illustration in Figma
// (`3699:23649`) — a local-vs-cloud comparison. Originally exported as a
// PNG (`screen-3-cards.png`) whose device mockup embedded the PocketPal
// mascot; redrawn as a live SVG so the mark is TwinCore-branded (no
// PocketPal artwork remains in the first-run flow). Same 369×217 slot.

export const Onboarding3Screen: React.FC = observer(() => {
  const {l10n, next, goBack} = useOnboardingHandlers(3);
  const t = l10n.onboarding;
  return (
    <OnboardingScaffold
      step={3}
      illustration={<LocalVsCloudCards width={369} />}
      content={
        <OnboardingContent
          eyebrow={t.screen3.eyebrow}
          title={
            <ItalicAccentTitle
              title={t.screen3.title}
              accent={t.screen3.titleAccent}
            />
          }
          body={
            <HighlightText
              body={t.screen3.body}
              phrases={[t.screen3.highlight]}
            />
          }
        />
      }
      bottomBar={
        <OnboardingBottomBar
          primaryLabel={t.screen3.cta}
          onPrimary={next}
          onBack={goBack}
          backAccessibilityLabel={t.back}
        />
      }
    />
  );
});
