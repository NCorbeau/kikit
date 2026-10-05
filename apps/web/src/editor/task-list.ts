import TaskList from '@tiptap/extension-task-list';
import { toggleSelectedTaskList } from './task-list-commands';
import { taskListPlugins } from './task-list-plugins';

export const FlatTaskList = TaskList.extend({
  // Concurrent deletion can leave an empty list until the server commits its
  // repair. Keep the wrapper in the client schema so its Yjs ID survives.
  content: 'taskItem*',

  addProseMirrorPlugins() {
    return taskListPlugins();
  },

  addCommands() {
    return {
      ...this.parent?.(),
      toggleTaskList: () => toggleSelectedTaskList(this.name, this.options.itemTypeName),
    };
  },
});
