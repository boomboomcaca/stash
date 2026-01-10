import React, { useState } from "react";
import { Button } from "react-bootstrap";
import { useIntl } from "react-intl";
import { Icon } from "src/components/Shared/Icon";
import { RatingSystem } from "src/components/Shared/Rating/RatingSystem";
import { faStar, faTrashAlt } from "@fortawesome/free-solid-svg-icons";
import { faStar as faStarRegular } from "@fortawesome/free-regular-svg-icons";
import cx from "classnames";

interface IScenePlayerActionsProps {
  rating100: number | null | undefined;
  onSetRating: (value: number | null) => void;
  onDelete: () => void;
  isVisible: boolean;
}

export const ScenePlayerActions: React.FC<IScenePlayerActionsProps> = ({
  rating100,
  onSetRating,
  onDelete,
  isVisible,
}) => {
  const intl = useIntl();
  const [showRating, setShowRating] = useState(false);

  const hasRating = rating100 !== null && rating100 !== undefined;

  return (
    <div
      className={cx("scene-player-actions", {
        visible: isVisible,
      })}
    >
      <div className="action-buttons">
        <div className="rating-container">
          <Button
            variant="link"
            className={cx("action-button rating-button", {
              "has-rating": hasRating,
            })}
            onClick={() => setShowRating(!showRating)}
            title={intl.formatMessage({ id: "rating" })}
          >
            <Icon icon={hasRating ? faStar : faStarRegular} />
          </Button>
          {showRating && (
            <div className="rating-popup">
              <RatingSystem
                value={rating100}
                onSetRating={(value) => {
                  onSetRating(value);
                }}
              />
            </div>
          )}
        </div>
        <Button
          variant="link"
          className="action-button delete-button"
          onClick={onDelete}
          title={intl.formatMessage({ id: "actions.delete" })}
        >
          <Icon icon={faTrashAlt} />
        </Button>
      </div>
    </div>
  );
};

export default ScenePlayerActions;
