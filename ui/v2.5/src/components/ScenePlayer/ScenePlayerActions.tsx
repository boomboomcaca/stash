import React, { useEffect, useRef, useState } from "react";
import { Button, Overlay, Popover } from "react-bootstrap";
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
  const ratingButtonRef = useRef<HTMLButtonElement>(null);

  // 当控制栏消失时，自动关闭评分弹出框
  useEffect(() => {
    if (!isVisible) {
      setShowRating(false);
    }
  }, [isVisible]);

  const hasRating = rating100 !== null && rating100 !== undefined;

  // 将 rating100 (0-100) 转换为星级 (1-5)
  const starRating = hasRating ? Math.round(rating100 / 20) : 0;

  return (
    <div
      className={cx("scene-player-actions", {
        visible: isVisible,
      })}
    >
      <div className="action-buttons">
        <div className="rating-container">
          <Button
            ref={ratingButtonRef}
            variant="link"
            className={cx("action-button rating-button", {
              "has-rating": hasRating,
            })}
            onClick={() => setShowRating(!showRating)}
            title={intl.formatMessage({ id: "rating" })}
          >
            <Icon icon={hasRating ? faStar : faStarRegular} />
            {hasRating && starRating > 0 && (
              <span className="rating-badge">{starRating}</span>
            )}
          </Button>
          <Overlay
            target={ratingButtonRef.current}
            show={showRating}
            placement="right"
            rootClose
            onHide={() => setShowRating(false)}
          >
            <Popover id="rating-popover" className="rating-popover">
              <Popover.Content>
                <RatingSystem
                  value={rating100}
                  onSetRating={(value) => {
                    onSetRating(value);
                  }}
                />
              </Popover.Content>
            </Popover>
          </Overlay>
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
