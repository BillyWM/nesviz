export default function IconButton({
  iconSrc,
  label,
  title,
  className = '',
  ...buttonProps
}) {
  return (
    <button
      type="button"
      className={`nv-btn nv-tool-icon-btn ${className}`.trim()}
      title={title || label}
      aria-label={label}
      {...buttonProps}
    >
      <img
        src={iconSrc}
        alt=""
        aria-hidden="true"
        className="nv-tool-icon-svg"
      />
    </button>
  );
}
