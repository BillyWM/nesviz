import refreshIconSrc from '../assets/icons/refresh.svg';
import IconButton from './IconButton.jsx';

export default function RefreshButton(props) {
  return (
    <IconButton
      iconSrc={refreshIconSrc}
      label="Refresh"
      {...props}
    />
  );
}
