import { faFilm } from "@fortawesome/free-solid-svg-icons";
import React from "react";
import { Button } from "react-bootstrap";
import { Icon } from "src/components/Shared/Icon";
import { SceneDataFragment } from "src/core/generated-graphql";
import { useConfigurationContext } from "src/hooks/Config";

export interface IPotPlayerButtonProps {
  scene: SceneDataFragment;
}

// Opens the scene's direct stream in the desktop PotPlayer via a custom
// `potplayer://` URL protocol. The protocol must be registered once on the
// user's machine (a browser cannot launch a local app otherwise) — the handler
// strips the `potplayer://` prefix and passes the real URL to PotPlayer. The
// stream URL carries the API key because an external player has no Stash
// session cookie.
export const PotPlayerButton: React.FC<IPotPlayerButtonProps> = ({ scene }) => {
  const { configuration } = useConfigurationContext();

  const stream = scene.paths?.stream;
  if (!stream) return <span />;

  // PotPlayer is a desktop player; the mobile ExternalPlayerButton already
  // covers Android/iOS.
  const isMobile = /(android|ipod|iphone|ipad)/i.test(navigator.userAgent);
  if (isMobile) return <span />;

  let potUrl: string;
  try {
    const url = new URL(stream, window.location.origin);
    const apiKey = configuration?.general?.apiKey;
    if (apiKey) url.searchParams.set("apikey", apiKey);
    potUrl = `potplayer://${url.toString()}`;
  } catch {
    return <span />;
  }

  return (
    <Button
      className="minimal px-0 px-sm-2 pt-2"
      variant="secondary"
      title="Open in PotPlayer"
    >
      <a href={potUrl}>
        <Icon icon={faFilm} color="white" />
      </a>
    </Button>
  );
};

export default PotPlayerButton;
