import folderIconSrc from '../assets/icons/folder.svg';
import IconButton from './IconButton.jsx';

export default function FolderButton(props) {
  return (
    <IconButton
      iconSrc={folderIconSrc}
      label="Select folders"
      {...props}
    />
  );
}
